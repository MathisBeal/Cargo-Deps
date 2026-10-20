// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from './services/analysis';
import { CargoHintsProvider } from './providers/hintsProvider';
import { CargoHoverProvider } from './providers/hoverProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const analysis = new DependencyAnalysisService();
	const selector: vscode.DocumentSelector = { language: 'toml', scheme: 'file' };
	context.subscriptions.push(
		analysis,
		vscode.languages.registerInlayHintsProvider(selector, new CargoHintsProvider(analysis)),
		vscode.languages.registerHoverProvider(selector, new CargoHoverProvider(analysis)),
		vscode.workspace.onDidOpenTextDocument(document => refreshDocument(document, analysis)),
		vscode.workspace.onDidSaveTextDocument(document => refreshDocument(document, analysis)),
		vscode.commands.registerCommand('cargo-deps.refresh', async () => {
			const document = vscode.window.activeTextEditor?.document;
			if (!document || !isCargoManifest(document)) {
				void vscode.window.showWarningMessage('Open a Cargo.toml file to refresh dependency analysis.');
				return;
			}
			await analysis.refresh(path.dirname(document.uri.fsPath));
			void vscode.window.showInformationMessage('Cargo dependency analysis refreshed.');
		}),
	);

	for (const document of vscode.workspace.textDocuments) {
		refreshDocument(document, analysis);
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}

function refreshDocument(document: vscode.TextDocument, analysis: DependencyAnalysisService): void {
	if (isCargoManifest(document)) {
		void analysis.refresh(path.dirname(document.uri.fsPath));
	}
}

function isCargoManifest(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && path.basename(document.uri.fsPath) === 'Cargo.toml';
}
