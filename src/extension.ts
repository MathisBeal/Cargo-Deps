// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from './services/analysis';
import { CargoHintsProvider } from './providers/hintsProvider';
import { CargoHoverProvider } from './providers/hoverProvider';
import { buildDiagnostics } from './providers/diagnosticsProvider';
import { AnalysisStatusBar } from './providers/statusBar';
import { AnalysisOutput } from './providers/output';
import { CargoCodeActionsProvider } from './providers/codeActionsProvider';
import { isCargoManifest, setVersion, SET_VERSION_COMMAND, updateManifests } from './services/updates';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const analysis = new DependencyAnalysisService();
	const output = new AnalysisOutput(analysis.onDidProgress);
	const statusBar = new AnalysisStatusBar(analysis.onDidProgress);
	const selector: vscode.DocumentSelector = { scheme: 'file', pattern: '**/Cargo.toml' };
	const diagnostics = vscode.languages.createDiagnosticCollection('cargo-deps');
	const manifestsWatcher = vscode.workspace.createFileSystemWatcher('**/Cargo.toml');
	let scanRunning: Promise<boolean> | undefined;
	let scanController: AbortController | undefined;
	let analysisHasErrors = false;
	let disposed = false;
	let roots = new Set<string>();
	const runUpdate = async (operation: () => Promise<void>): Promise<void> => {
		try {
			if (!vscode.workspace.isTrusted) {
				throw new Error('Trust this workspace to update Cargo dependencies.');
			}
			await operation();
		} catch (error) {
			output.error('Dependency update failed.', error);
			void vscode.window.showErrorMessage(`Cargo dependency update failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const refreshWorkspace = (): Promise<boolean> => {
		if (!vscode.workspace.isTrusted || disposed) {
			return Promise.resolve(false);
		}
		scanController?.abort();
		const controller = new AbortController();
		scanController = controller;
		const { signal } = controller;
		const discovery = new vscode.CancellationTokenSource();
		const cancelDiscovery = () => discovery.cancel();
		signal.addEventListener('abort', cancelDiscovery, { once: true });
		scanRunning = (async () => {
			try {
				analysisHasErrors = false;
				statusBar.discover();
				const manifests = await vscode.workspace.findFiles('**/Cargo.toml', '**/{target,node_modules,.git}/**', undefined, discovery.token);
				signal.throwIfAborted();
				const openManifests = vscode.workspace.textDocuments.filter(isCargoManifest).map(document => document.uri);
				const nextRoots = new Set([...manifests, ...openManifests].map(uri => path.dirname(uri.fsPath)));
				for (const root of roots) {
					if (!nextRoots.has(root)) {
						analysis.forget(root);
						diagnostics.delete(vscode.Uri.file(path.join(root, 'Cargo.toml')));
					}
				}
				roots = nextRoots;
				await analysis.refreshAll([...roots], signal);
				signal.throwIfAborted();
				return true;
			} catch (error) {
				if (signal.aborted) {
					return false;
				}
				analysisHasErrors = true;
				output.error('Workspace scan failed.', error);
				statusBar.fail(error instanceof Error ? error.message : String(error));
				void vscode.window.showWarningMessage(`Cargo dependency analysis failed: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			} finally {
				signal.removeEventListener('abort', cancelDiscovery);
				discovery.dispose();
				if (scanController === controller) {
					scanController = undefined;
					scanRunning = undefined;
				}
			}
		})();
		return scanRunning;
	};
	context.subscriptions.push(
		analysis,
		output,
		statusBar,
		diagnostics,
		manifestsWatcher,
		{ dispose: () => { disposed = true; scanController?.abort(); } },
		analysis.onDidProgress(progress => {
			analysisHasErrors = progress.status === 'failed' || progress.errors.length > 0;
		}),
		analysis.onDidAnalyze(snapshot => {
			if (!disposed && roots.has(snapshot.root)) {
				diagnostics.set(vscode.Uri.file(path.join(snapshot.root, 'Cargo.toml')), buildDiagnostics(snapshot));
			}
		}),
		vscode.languages.registerInlayHintsProvider(selector, new CargoHintsProvider(analysis)),
		vscode.languages.registerHoverProvider(selector, new CargoHoverProvider(analysis)),
		vscode.languages.registerCodeActionsProvider(selector, new CargoCodeActionsProvider(analysis), {
			providedCodeActionKinds: CargoCodeActionsProvider.providedCodeActionKinds,
		}),
		vscode.workspace.onDidOpenTextDocument(document => {
			const root = path.dirname(document.uri.fsPath);
			if (isCargoManifest(document) && !analysis.getSnapshot(root) && (!scanRunning || !roots.has(root))) {
				void refreshWorkspace();
			}
		}),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (isCargoManifest(document)) {
				void refreshWorkspace();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			diagnostics.clear();
			void refreshWorkspace();
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => { void refreshWorkspace(); }),
		manifestsWatcher.onDidCreate(() => { void refreshWorkspace(); }),
		manifestsWatcher.onDidDelete(uri => {
			scanController?.abort();
			const root = path.dirname(uri.fsPath);
			roots.delete(root);
			analysis.forget(root);
			diagnostics.delete(uri);
			void refreshWorkspace();
		}),
		vscode.commands.registerCommand('cargo-deps.showOutput', () => output.show()),
		vscode.commands.registerCommand(SET_VERSION_COMMAND, (selection: unknown) => runUpdate(() => setVersion(analysis, selection))),
		vscode.commands.registerCommand('cargo-deps.updateOpen', () => runUpdate(async () => {
			const manifests = vscode.workspace.textDocuments.filter(isCargoManifest).map(document => document.uri);
			if (!await refreshWorkspace()) {
				return;
			}
			await updateManifests(analysis, manifests);
		})),
		vscode.commands.registerCommand('cargo-deps.updateAll', () => runUpdate(async () => {
			if (!await refreshWorkspace()) {
				return;
			}
			await updateManifests(analysis, [...roots].map(root => vscode.Uri.file(path.join(root, 'Cargo.toml'))));
		})),
		vscode.commands.registerCommand('cargo-deps.refresh', async () => {
			if (!vscode.workspace.isTrusted) {
				void vscode.window.showWarningMessage('Trust this workspace to run Cargo dependency analysis.');
				return;
			}
			if (!await refreshWorkspace()) {
				return;
			}
			if (analysisHasErrors) {
				void vscode.window.showWarningMessage('Cargo dependency analysis finished with errors. See Cargo Deps output for details.');
			} else {
				void vscode.window.showInformationMessage('Cargo dependency analysis refreshed.');
			}
		}),
	);

	void refreshWorkspace();
}

// This method is called when your extension is deactivated
export function deactivate() {}
