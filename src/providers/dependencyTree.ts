import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from '../services/analysis';
import type { AnalysisProgress } from '../services/progress';
import type { Advisory, AnalysisSnapshot, DependencyHealth } from '../types';
import {
	applyDependencyUpdates, canUpdateToLatest, isCargoManifest, prepareDependencyUpdates,
} from '../services/updates';
import type { DependencyUpdateRequest } from '../services/updates';
import { buildDependencyHover, formatDependencyPath } from './hoverProvider';

export type DependencyView = 'dependencies' | 'updates' | 'security';

export type DependencyTreeNode =
	| { kind: 'crate'; snapshot: AnalysisSnapshot; children: DependencyTreeNode[] }
	| ({ kind: 'dependency' } & DependencyUpdateRequest)
	| { kind: 'advisory'; snapshot: AnalysisSnapshot; advisory: Advisory; via: DependencyHealth[] }
	| { kind: 'message'; snapshot: AnalysisSnapshot; label: string };

export function crateLabel(snapshot: AnalysisSnapshot): string {
	return snapshot.packageName || path.basename(snapshot.root);
}

function manifestUri(snapshot: AnalysisSnapshot): vscode.Uri {
	return vscode.Uri.file(path.join(snapshot.root, 'Cargo.toml'));
}

function manifestChanged(snapshot: AnalysisSnapshot): boolean {
	return vscode.workspace.textDocuments.some(document => document.uri.toString() === manifestUri(snapshot).toString()
		&& document.getText() !== snapshot.contents);
}

function advisoryKey(advisory: Advisory): string {
	return JSON.stringify([advisory.id, advisory.packageName, advisory.packageVersion, advisory.title, advisory.severity]);
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyTreeNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<DependencyTreeNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly subscriptions: vscode.Disposable[];
	private selectedRoot?: string;

	constructor(readonly view: DependencyView, private readonly analysis: DependencyAnalysisService) {
		this.subscriptions = [
			analysis.onDidChange(() => {
				if (this.selectedRoot && !analysis.getSnapshot(this.selectedRoot)) {
					this.selectedRoot = undefined;
				}
				this.emitter.fire(undefined);
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (isCargoManifest(event.document) && analysis.getSnapshot(path.dirname(event.document.uri.fsPath))) {
					this.emitter.fire(undefined);
				}
			}),
		];
	}

	get filterRoot(): string | undefined { return this.selectedRoot; }

	setFilter(root?: string): void {
		if (root && !this.analysis.getSnapshot(root)) {
			throw new Error('This crate is no longer available in the dependency analysis.');
		}
		this.selectedRoot = root;
		this.emitter.fire(undefined);
	}

	getUpdateRequests(root = this.selectedRoot): DependencyUpdateRequest[] {
		return this.analysis.getSnapshots().filter(snapshot => !root || snapshot.root === root)
			.flatMap(snapshot => snapshot.dependencies.filter(canUpdateToLatest).map(health => ({ snapshot, health })));
	}

	getChildren(element?: DependencyTreeNode): DependencyTreeNode[] {
		if (element) {
			return element.kind === 'crate' ? element.children : [];
		}
		return [...this.analysis.getSnapshots()]
			.filter(snapshot => this.view !== 'updates' || !this.selectedRoot || snapshot.root === this.selectedRoot)
			.sort((left, right) => crateLabel(left).localeCompare(crateLabel(right)) || left.root.localeCompare(right.root))
			.flatMap(snapshot => {
				const children = this.childrenFor(snapshot);
				return children.length || this.view === 'dependencies' ? [{ kind: 'crate' as const, snapshot, children }] : [];
			});
	}

	private childrenFor(snapshot: AnalysisSnapshot): DependencyTreeNode[] {
		if (this.view !== 'security') {
			return snapshot.dependencies.filter(health => this.view !== 'updates' || canUpdateToLatest(health))
				.sort((left, right) => left.dependency.name.localeCompare(right.dependency.name) || left.dependency.line - right.dependency.line)
				.map(health => ({ kind: 'dependency', snapshot, health }));
		}
		const alerts = new Map<string, Extract<DependencyTreeNode, { kind: 'advisory' }>>();
		for (const health of snapshot.dependencies) {
			for (const advisory of health.advisories) {
				const key = advisoryKey(advisory);
				const existing = alerts.get(key);
				if (existing) {
					if (!existing.via.includes(health)) {
						existing.via.push(health);
					}
				} else {
					alerts.set(key, { kind: 'advisory', snapshot, advisory, via: [health] });
				}
			}
		}
		const children: DependencyTreeNode[] = [...alerts.values()]
			.sort((left, right) => left.advisory.packageName.localeCompare(right.advisory.packageName)
				|| left.advisory.id.localeCompare(right.advisory.id));
		if (snapshot.auditAvailable === false || snapshot.dependencies.some(health => health.auditAvailable === false)) {
			children.unshift({ kind: 'message', snapshot, label: 'Security analysis unavailable' });
		}
		return children;
	}

	getTreeItem(element: DependencyTreeNode): vscode.TreeItem {
		const { snapshot } = element;
		const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
		const uri = manifestUri(snapshot);
		const changed = manifestChanged(snapshot);
		if (element.kind === 'crate') {
			const count = element.children.filter(child => child.kind !== 'message').length;
			const unavailable = this.view === 'security' && element.children.some(child => child.kind === 'message');
			item.label = crateLabel(snapshot);
			item.description = [
				snapshot.packageName ? '' : 'workspace', unavailable && !count ? '' : String(count),
				unavailable ? 'audit unavailable' : '', changed ? 'modified' : '',
			].filter(Boolean).join(' · ');
			item.collapsibleState = element.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
			item.iconPath = new vscode.ThemeIcon(unavailable ? 'warning' : 'package');
			item.tooltip = vscode.workspace.asRelativePath(uri, true);
			item.contextValue = this.view === 'updates' ? 'cargo-deps.updateCrate' : 'cargo-deps.crate';
		} else if (element.kind === 'message') {
			item.label = element.label;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
			item.tooltip = 'cargo audit failed. Open Cargo Deps output for details.';
			item.command = { command: 'cargo-deps.showOutput', title: 'Open analysis log' };
		} else {
			const health = element.kind === 'dependency' ? element.health : element.via[0];
			item.command = {
				command: 'vscode.open', title: 'Open dependency declaration',
				arguments: [uri, {
					preview: true,
					selection: changed ? undefined : new vscode.Range(health.dependency.line, 0, health.dependency.line, 0),
				}],
			};
			if (element.kind === 'dependency') {
				item.label = health.dependency.name;
				const version = this.view === 'updates'
					? `${health.installedVersion} → ${health.latestVersion}` : health.installedVersion || health.dependency.versionRequirement;
				const section = health.dependency.section ?? '';
				const source = [
					health.dependency.workspace === 'declaration' ? 'workspace' : '',
					section.startsWith('target.') ? 'target' : '',
					section.endsWith('dev-dependencies') ? 'dev' : section.endsWith('build-dependencies') ? 'build' : '',
				].filter(Boolean).join(' ');
				item.description = [version, source].filter(Boolean).join(' · ');
				item.iconPath = new vscode.ThemeIcon(health.advisories.length ? 'warning' : canUpdateToLatest(health) ? 'arrow-up' : 'symbol-package');
				item.contextValue = vscode.workspace.isTrusted && canUpdateToLatest(health) && !changed
					? 'cargo-deps.updatable' : 'cargo-deps.dependency';
			} else {
				item.label = element.advisory.id === 'Unknown advisory' ? element.advisory.severity || 'Audit warning' : element.advisory.id;
				item.description = `${element.advisory.packageName} ${element.advisory.packageVersion}`;
				item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
				item.tooltip = advisoryTooltip(element);
			}
		}
		item.id = JSON.stringify([this.view, snapshot.root, element.kind,
			element.kind === 'dependency' ? [element.health.dependency.name, element.health.dependency.line]
				: element.kind === 'advisory' ? advisoryKey(element.advisory) : '']);
		return item;
	}

	async resolveTreeItem(item: vscode.TreeItem, element: DependencyTreeNode, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
		if (element.kind !== 'dependency' || token.isCancellationRequested) {
			return item;
		}
		const document = await vscode.workspace.openTextDocument(manifestUri(element.snapshot));
		if (token.isCancellationRequested) {
			return item;
		}
		if (this.analysis.getSnapshot(element.snapshot.root) !== element.snapshot || document.getText() !== element.snapshot.contents) {
			item.tooltip = 'Manifest or analysis changed. Save the manifest and refresh to see current dependency details.';
		} else {
			item.tooltip = buildDependencyHover(element.health, document);
		}
		return item;
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.emitter.dispose();
	}
}

function advisoryTooltip(element: Extract<DependencyTreeNode, { kind: 'advisory' }>): vscode.MarkdownString {
	const { advisory, via } = element;
	const tooltip = new vscode.MarkdownString();
	tooltip.appendText(`${advisory.id}: ${advisory.title}\n\nPackage: ${advisory.packageName} ${advisory.packageVersion}`);
	if (advisory.severity) {
		tooltip.appendText(`\nSeverity: ${advisory.severity}`);
	}
	tooltip.appendText(`\nAffects: ${[...new Set(via.map(health => health.dependency.name))].join(', ')}`);
	for (const health of via) {
		const entry = health.advisories.find(candidate => advisoryKey(candidate) === advisoryKey(advisory));
		const trace = entry?.treePath ? formatDependencyPath(entry.treePath, health.dependency.packageName) : undefined;
		if (trace) {
			tooltip.appendCodeblock(trace, 'text');
		}
	}
	return tooltip;
}

export class DependencyTreeViews implements vscode.Disposable {
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(
		private readonly analysis: DependencyAnalysisService,
		private readonly reportError: (message: string, error: unknown) => void,
	) {
		const providers = new Map<DependencyView, DependencyTreeProvider>();
		const views = new Map<DependencyView, vscode.TreeView<DependencyTreeNode>>();
		let progress: AnalysisProgress | undefined;
		const updateMessages = () => {
			for (const [kind, view] of views) {
				const provider = providers.get(kind)!;
				const groups = provider.getChildren();
				const scope = provider.filterRoot ? analysis.getSnapshot(provider.filterRoot) : undefined;
				view.description = scope ? crateLabel(scope) : undefined;
				view.message = !vscode.workspace.isTrusted ? 'Trust this workspace to analyze dependencies.'
					: progress?.status === 'running' ? `Analyzing workspace · ${progress.manifestsCompleted}/${progress.manifestsTotal}`
						: progress && (progress.status === 'failed' || progress.errors.length) ? 'Partial results. See Cargo Deps output for details.'
							: !analysis.getSnapshots().length ? 'Open a Rust workspace and refresh to analyze dependencies.'
								: groups.length ? undefined
									: kind === 'updates' ? 'No available requirement updates in this scope.'
										: 'No security alerts reported by the last analysis.';
			}
		};
		for (const kind of ['dependencies', 'updates', 'security'] as const) {
			const provider = new DependencyTreeProvider(kind, analysis);
			const view = vscode.window.createTreeView(`cargo-deps.${kind}`, { treeDataProvider: provider, showCollapseAll: true });
			providers.set(kind, provider);
			views.set(kind, view);
			this.subscriptions.push(provider, view, provider.onDidChangeTreeData(updateMessages));
		}
		let previousSummary: string | undefined;
		this.subscriptions.push(analysis.onDidProgress(value => {
			progress = value;
			const summary = JSON.stringify([value.status, value.manifestsCompleted, value.manifestsTotal, value.errors.length]);
			if (summary !== previousSummary) {
				previousSummary = summary;
				updateMessages();
			}
		}));
		const updates = providers.get('updates')!;
		this.subscriptions.push(
			vscode.commands.registerCommand('cargo-deps.filterUpdates', () => this.run('Could not filter updates.', async () => {
				const items: (vscode.QuickPickItem & { root?: string })[] = [
					{ label: 'All crates', picked: !updates.filterRoot },
					...analysis.getSnapshots().map(snapshot => ({
						label: crateLabel(snapshot), description: vscode.workspace.asRelativePath(manifestUri(snapshot), true),
						root: snapshot.root, picked: updates.filterRoot === snapshot.root,
					})).sort((left, right) => left.label.localeCompare(right.label)),
				];
				const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Show updates for all crates or one crate' });
				if (selected) {
					updates.setFilter(selected.root);
				}
			})),
			vscode.commands.registerCommand('cargo-deps.updateDependency', (node?: DependencyTreeNode) => this.run('Dependency update failed.', async () => {
				if (node?.kind !== 'dependency') {
					throw new Error('Select a dependency from Cargo Deps first.');
				}
				const plan = await prepareDependencyUpdates(analysis, [node]);
				await applyDependencyUpdates(analysis, plan);
				this.updated(plan.count);
			})),
			vscode.commands.registerCommand('cargo-deps.updateVisible', (node?: DependencyTreeNode) => this.run('Dependency updates failed.', async () => {
				if (node && (node.kind !== 'crate' || analysis.getSnapshot(node.snapshot.root) !== node.snapshot)) {
					throw new Error('Select a current crate from Cargo Deps first.');
				}
				const requests = updates.getUpdateRequests(node?.snapshot.root);
				if (!requests.length) {
					void vscode.window.showInformationMessage('No dependency requirements need updating in this scope.');
					return;
				}
				const plan = await prepareDependencyUpdates(analysis, requests);
				const choice = await vscode.window.showWarningMessage(`Update ${plan.count} dependency requirement(s) to latest?`, {
					modal: true,
					detail: 'This can include major or prerelease versions. Shared workspace declarations are updated only once. Changes remain unsaved for review; Cargo.lock is not modified.',
				}, 'Update');
				if (choice === 'Update') {
					await applyDependencyUpdates(analysis, plan);
					this.updated(plan.count);
				}
			})),
		);
		updateMessages();
	}

	private updated(count: number): void {
		void vscode.window.showInformationMessage(`Updated ${count} dependency requirement(s). Review and save the manifests to refresh analysis.`);
	}

	private async run(message: string, operation: () => Promise<void>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			this.reportError(message, error);
		}
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
