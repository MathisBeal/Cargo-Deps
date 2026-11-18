import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from '../services/analysis';
import type { AnalysisProgress } from '../services/progress';
import type { Advisory, AnalysisSnapshot, DependencyHealth } from '../types';
import {
	applyDependencyUpdates, canUpdateToLatest, prepareDependencyUpdates,
	dependencyUpdateTarget,
} from '../services/updates';
import type { DependencyUpdateRequest } from '../services/updates';
import { buildDependencyHover, formatDependencyPath } from './hoverProvider';
import { PanelModel } from '../services/panelModel';
import { releaseForPolicy, versionChange } from '../services/versionChanges';
import type { UpdatePolicy } from '../services/versionChanges';

export type DependencyView = 'dependencies' | 'updates' | 'security';

export type DependencyTreeNode =
	| { kind: 'crate'; snapshot: AnalysisSnapshot; children: DependencyTreeNode[] }
	| ({ kind: 'dependency' } & DependencyUpdateRequest)
	| ({ kind: 'usage' } & DependencyUpdateRequest)
	| ({ kind: 'update'; requests: DependencyUpdateRequest[]; usages: DependencyUpdateRequest[]; key: string } & DependencyUpdateRequest)
	| { kind: 'advisory'; snapshot: AnalysisSnapshot; advisory: Advisory; via: DependencyHealth[] }
	| { kind: 'message'; snapshot: AnalysisSnapshot; label: string; detail?: string; key?: string };

function alertPriority(advisory: Advisory): { rank: number; label: string } {
	const severity = advisory.severity?.toLowerCase() ?? '';
	if (['unmaintained', 'yanked', 'unsound', 'notice'].includes(severity)) {
		return { rank: 6, label: 'Warning' };
	}
	const named: Record<string, number> = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };
	if (Object.hasOwn(named, severity)) {
		return { rank: named[severity], label: severity === 'moderate' ? 'Medium' : severity[0].toUpperCase() + severity.slice(1) };
	}
	// Cargo can provide a CVSS vector instead of a named severity; do not guess its score.
	return { rank: 4, label: 'Unknown severity' };
}

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

function declarationKey({ snapshot, health }: DependencyUpdateRequest): string {
	const dependency = health.dependency;
	return JSON.stringify([
		dependency.workspace === 'inherited' ? snapshot.workspaceRoot : snapshot.root,
		dependency.workspace === 'inherited' ? 'workspace.dependencies' : dependency.section,
		dependency.name, dependency.packageName,
	]);
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyTreeNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<DependencyTreeNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly subscriptions: vscode.Disposable[];
	private selectedRoot?: string;
	private grouping: 'dependency' | 'crate' = 'dependency';
	private policy: UpdatePolicy = 'stable';
	readonly model: PanelModel;
	private readonly ownsModel: boolean;

	constructor(readonly view: DependencyView, private readonly analysis: DependencyAnalysisService, model?: PanelModel) {
		this.model = model ?? new PanelModel(analysis);
		this.ownsModel = !model;
		this.subscriptions = [
			this.model.onDidChange(() => {
				if (this.selectedRoot && !analysis.getSnapshot(this.selectedRoot)) {
					this.selectedRoot = undefined;
				}
				this.emitter.fire(undefined);
			}),
		];
	}

	get filterRoot(): string | undefined { return this.selectedRoot; }
	get updateGrouping() { return this.grouping; }
	get updatePolicy() { return this.policy; }

	setGrouping(grouping: 'dependency' | 'crate'): void {
		this.grouping = grouping;
		this.emitter.fire(undefined);
	}

	setPolicy(policy: UpdatePolicy): void {
		this.policy = policy;
		this.emitter.fire(undefined);
	}

	setFilter(root?: string): void {
		if (root && !this.analysis.getSnapshot(root)) {
			throw new Error('This crate is no longer available in the dependency analysis.');
		}
		this.selectedRoot = root;
		this.emitter.fire(undefined);
	}

	getUpdateRequests(root = this.selectedRoot): DependencyUpdateRequest[] {
		return this.model.getSnapshots().filter(snapshot => !root || snapshot.root === root)
			.flatMap(snapshot => snapshot.dependencies.map(health => releaseForPolicy(health, this.policy))
				.filter(health => canUpdateToLatest(health) && (this.policy !== 'compatible' || versionChange(health) === 'compatible'))
				.map(health => ({ snapshot, health })));
	}

	getChildren(element?: DependencyTreeNode): DependencyTreeNode[] {
		if (element) {
			if (element.kind === 'update') {
				return [...element.usages].sort((left, right) => crateLabel(left.snapshot).localeCompare(crateLabel(right.snapshot))
					|| left.health.dependency.line - right.health.dependency.line).map(request => ({
					kind: 'usage', snapshot: request.snapshot, health: { ...request.health, latestVersion: element.health.latestVersion },
				}));
			}
			return element.kind === 'crate' ? element.children : [];
		}
		if (this.view === 'updates' && this.grouping === 'dependency') {
			return this.groupedUpdates();
		}
		const groups = [...this.model.getSnapshots()]
			.filter(snapshot => this.view !== 'updates' || !this.selectedRoot || snapshot.root === this.selectedRoot)
			.sort((left, right) => crateLabel(left).localeCompare(crateLabel(right)) || left.root.localeCompare(right.root))
			.flatMap(snapshot => {
				const children = this.childrenFor(snapshot);
				return children.length || this.view === 'dependencies' ? [{ kind: 'crate' as const, snapshot, children }] : [];
			});
		return this.view === 'security' ? groups.sort((left, right) => this.crateRisk(left.children) - this.crateRisk(right.children)
			|| crateLabel(left.snapshot).localeCompare(crateLabel(right.snapshot))) : groups;
	}

	private crateRisk(children: DependencyTreeNode[]): number {
		return Math.min(7, ...children.map(node => node.kind === 'advisory' ? alertPriority(node.advisory).rank : 4));
	}

	private groupedUpdates(): DependencyTreeNode[] {
		const snapshots = this.model.getSnapshots();
		const source = { getSnapshot: (root: string) => snapshots.find(snapshot => snapshot.root === root) };
		const groups = new Map<string, Extract<DependencyTreeNode, { kind: 'update' }>>();
		const usages = new Map<string, DependencyUpdateRequest[]>();
		for (const snapshot of snapshots) {
			for (const health of snapshot.dependencies) {
				if (health.dependency.workspace !== 'declaration') {
					const key = declarationKey({ snapshot, health });
					const users = usages.get(key) ?? [];
					users.push({ snapshot, health });
					usages.set(key, users);
				}
			}
		}
		const unavailable: DependencyTreeNode[] = snapshots
			.filter(snapshot => (!this.selectedRoot || snapshot.root === this.selectedRoot) && this.model.problem(snapshot.root))
			.map(snapshot => ({
				kind: 'message', snapshot, label: `${crateLabel(snapshot)}: fix invalid manifest edits`,
				detail: this.model.problem(snapshot.root),
			}));
		for (const request of this.getUpdateRequests()) {
			try {
				const target = dependencyUpdateTarget(source, request);
				const key = JSON.stringify([declarationKey(target), request.health.latestVersion]);
				const previous = groups.get(key);
				if (previous) {
					previous.requests.push(request);
				} else {
					groups.set(key, {
						kind: 'update', snapshot: target.snapshot,
						health: { ...target.health, latestVersion: request.health.latestVersion }, requests: [request], key,
						usages: usages.get(declarationKey(target)) ?? [],
					});
				}
			} catch (error) {
				unavailable.push({
					kind: 'message', snapshot: request.snapshot,
					label: `${request.health.dependency.name}: declaration unavailable`,
					key: JSON.stringify([request.health.dependency.section, request.health.dependency.name]),
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return [
			...[...groups.values()].sort((left, right) => left.health.dependency.packageName.localeCompare(right.health.dependency.packageName)
				|| left.key.localeCompare(right.key)),
			...unavailable,
		];
	}

	private childrenFor(snapshot: AnalysisSnapshot): DependencyTreeNode[] {
		const problem = this.model.problem(snapshot.root);
		if (problem) {
			return [{ kind: 'message', snapshot, label: 'Fix invalid manifest edits', detail: problem }];
		}
		if (this.view !== 'security') {
			return (this.view === 'updates' ? this.getUpdateRequests(snapshot.root).map(request => request.health)
				: snapshot.dependencies.map(health => releaseForPolicy(health, 'stable')))
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
			.sort((left, right) => alertPriority(left.advisory).rank - alertPriority(right.advisory).rank
				|| left.advisory.packageName.localeCompare(right.advisory.packageName)
				|| left.advisory.id.localeCompare(right.advisory.id));
		const unanalyzed = (health: DependencyHealth) => this.model.isPending(snapshot.root) && !health.installedVersion;
		if (snapshot.dependencies.some(unanalyzed)) {
			children.unshift({
				kind: 'message', snapshot, label: 'Changed dependencies need analysis',
				detail: 'New or changed dependency sources have not been analyzed. Save the manifest to refresh versions and security results.',
			});
		}
		if (snapshot.auditAvailable === false || snapshot.dependencies.some(health => health.auditAvailable === false && !unanalyzed(health))) {
			children.unshift({ kind: 'message', snapshot, label: 'Security analysis unavailable' });
		}
		return children;
	}

	getTreeItem(element: DependencyTreeNode): vscode.TreeItem {
		const { snapshot } = element;
		const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
		const uri = manifestUri(snapshot);
		const changed = manifestChanged(snapshot);
		const pending = this.model.isPending(snapshot.root);
		const problem = this.model.problem(snapshot.root);
		if (element.kind === 'crate') {
			const count = element.children.filter(child => child.kind !== 'message').length;
			const unavailable = this.view === 'security' && element.children.some(child => child.kind === 'message' && !child.detail);
			item.label = crateLabel(snapshot);
			item.description = [
				snapshot.packageName ? '' : 'workspace', problem ? 'invalid manifest' : unavailable && !count ? '' : String(count),
				unavailable ? 'audit unavailable' : '', pending ? 'pending edits' : changed ? 'editing…' : '',
			].filter(Boolean).join(' · ');
			item.collapsibleState = element.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
			item.iconPath = new vscode.ThemeIcon(unavailable || problem ? 'warning' : 'package');
			item.tooltip = vscode.workspace.asRelativePath(uri, true);
			item.contextValue = this.view === 'updates' ? 'cargo-deps.updateCrate' : 'cargo-deps.crate';
		} else if (element.kind === 'message') {
			item.label = element.label;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
			item.tooltip = element.detail || 'cargo audit failed. Open Cargo Deps output for details.';
			item.command = element.detail ? { command: 'vscode.open', title: 'Open manifest', arguments: [uri] }
				: { command: 'cargo-deps.showOutput', title: 'Open analysis log' };
		} else {
			const health = element.kind === 'advisory' ? element.via[0] : element.health;
			item.command = {
				command: 'vscode.open', title: 'Open dependency declaration',
				arguments: [uri, {
					preview: true,
					selection: changed ? undefined : new vscode.Range(health.dependency.line, 0, health.dependency.line, 0),
				}],
			};
			if (element.kind !== 'advisory') {
				item.label = element.kind === 'usage' ? crateLabel(snapshot)
					: element.kind === 'update' && health.dependency.name !== health.dependency.packageName
						? `${health.dependency.packageName} (${health.dependency.name})` : health.dependency.name;
				const version = this.view === 'updates'
					? `${health.installedVersion} → ${health.latestVersion}` : health.installedVersion || health.dependency.versionRequirement;
				const section = health.dependency.section ?? '';
				const source = [
					health.dependency.workspace === 'declaration' ? 'workspace' : '',
					section.startsWith('target.') ? 'target' : '',
					section.endsWith('dev-dependencies') ? 'dev' : section.endsWith('build-dependencies') ? 'build' : '',
				].filter(Boolean).join(' ');
				const base = this.analysis.getSnapshot(snapshot.root)?.dependencies.find(candidate =>
					candidate.dependency.name === health.dependency.name && candidate.dependency.section === health.dependency.section);
				const requirementChanged = base && base.dependency.versionRequirement !== health.dependency.versionRequirement;
				if (element.kind === 'update') {
					const users = new Set(element.usages.map(request => request.snapshot.root));
					item.description = `${health.dependency.versionRequirement} → ${health.latestVersion} · ${versionChange(health)} · ${users.size ? `${users.size} crate(s)` : 'workspace'} · ${crateLabel(snapshot)}${source ? `: ${source}` : ''}`;
					item.collapsibleState = users.size ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
				} else {
					item.description = [
						requirementChanged ? `${health.dependency.versionRequirement} (pending)` : version,
						this.view === 'updates' ? versionChange(health) : '', source,
					].filter(Boolean).join(' · ');
				}
				item.iconPath = new vscode.ThemeIcon(health.advisories.length ? 'warning' : canUpdateToLatest(health) ? 'arrow-up' : 'symbol-package');
				item.contextValue = element.kind !== 'usage' && vscode.workspace.isTrusted && canUpdateToLatest(health)
					&& this.model.getSnapshot(snapshot.root) === snapshot
					? 'cargo-deps.updatable' : 'cargo-deps.dependency';
			} else {
				const risk = alertPriority(element.advisory);
				const title = element.advisory.title.replace(/\s+/g, ' ');
				item.label = title.length > 75 ? `${title.slice(0, 72)}…` : title;
				item.description = `${risk.label} · ${element.advisory.packageName} ${element.advisory.packageVersion}`;
				item.iconPath = new vscode.ThemeIcon(risk.rank < 2 ? 'error' : 'warning',
					new vscode.ThemeColor(risk.rank < 2 ? 'list.errorForeground' : 'list.warningForeground'));
				item.tooltip = advisoryTooltip(element);
				if (pending) {
					item.tooltip.value = '**Pending edits — security results are from the last scan.**\n\n' + item.tooltip.value;
				}
			}
		}
		item.id = JSON.stringify([this.view, snapshot.root, element.kind,
			element.kind === 'update' ? element.key
				: element.kind === 'dependency' || element.kind === 'usage' ? [element.health.dependency.name, element.health.dependency.section]
				: element.kind === 'advisory' ? advisoryKey(element.advisory)
					: element.kind === 'message' ? element.key || element.label : '']);
		return item;
	}

	async resolveTreeItem(item: vscode.TreeItem, element: DependencyTreeNode, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
		if (element.kind === 'crate' || element.kind === 'advisory' || element.kind === 'message' || token.isCancellationRequested) {
			return item;
		}
		const document = await vscode.workspace.openTextDocument(manifestUri(element.snapshot));
		if (token.isCancellationRequested) {
			return item;
		}
		await this.model.whenSettled();
		if (this.model.getSnapshot(element.snapshot.root) !== element.snapshot || document.getText() !== element.snapshot.contents) {
			item.tooltip = 'Manifest or analysis changed. Reopen this row after the panel refreshes.';
		} else if (this.model.isPending(element.snapshot.root) && !element.health.installedVersion) {
			item.tooltip = 'New or changed dependency source. Save the manifest to analyze its installed version, releases and security results.';
		} else {
			item.tooltip = buildDependencyHover(element.health, document);
			if (element.kind === 'update') {
				const context = new vscode.MarkdownString().appendText(
					`Declaration: ${vscode.workspace.asRelativePath(document.uri, true)} [${element.health.dependency.section ?? ''}]`,
				);
				item.tooltip.value = context.value + '\n\n' + item.tooltip.value;
			}
			if (this.model.isPending(element.snapshot.root)) {
				item.tooltip.value = '**Pending edits — installed versions and security results are from the last scan.**\n\n' + item.tooltip.value;
			}
		}
		return item;
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.emitter.dispose();
		if (this.ownsModel) {
			this.model.dispose();
		}
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
		const model = new PanelModel(analysis);
		this.subscriptions.push(model);
		let progress: AnalysisProgress | undefined;
		const updateMessages = () => {
			for (const [kind, view] of views) {
				const provider = providers.get(kind)!;
				const groups = provider.getChildren();
				const scope = provider.filterRoot ? analysis.getSnapshot(provider.filterRoot) : undefined;
				view.description = kind === 'updates'
					? `${scope ? crateLabel(scope) : 'All crates'} · ${provider.updateGrouping} · ${provider.updatePolicy}` : undefined;
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
			const provider = new DependencyTreeProvider(kind, analysis, model);
			const view = vscode.window.createTreeView(`cargo-deps.${kind}`, { treeDataProvider: provider, showCollapseAll: true });
			providers.set(kind, provider);
			views.set(kind, view);
			this.subscriptions.push(provider, view);
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
			updates.onDidChangeTreeData(updateMessages),
			vscode.commands.registerCommand('cargo-deps.filterUpdates', () => this.run('Could not filter updates.', async () => {
				const setting = await vscode.window.showQuickPick([
					{ label: 'Crate scope', description: updates.filterRoot ? crateLabel(analysis.getSnapshot(updates.filterRoot)!) : 'All crates', action: 'scope' },
					{ label: 'Grouping', description: updates.updateGrouping, action: 'grouping' },
					{ label: 'Release policy', description: updates.updatePolicy, action: 'policy' },
				], { placeHolder: 'Configure the updates view' });
				if (setting?.action === 'scope') {
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
				} else if (setting?.action === 'grouping') {
					const choice = await vscode.window.showQuickPick([
						{ label: 'By declaration', value: 'dependency' as const, description: 'One update per shared declaration' },
						{ label: 'By crate', value: 'crate' as const },
					]);
					if (choice) { updates.setGrouping(choice.value); }
				} else if (setting?.action === 'policy') {
					const choice = await vscode.window.showQuickPick([
						{ label: 'Stable releases', value: 'stable' as const },
						{ label: 'Compatible with current requirements', value: 'compatible' as const },
						{ label: 'Include prereleases', value: 'prereleases' as const },
					]);
					if (choice) { updates.setPolicy(choice.value); }
				}
			})),
			vscode.commands.registerCommand('cargo-deps.updateDependency', (node?: DependencyTreeNode) => this.run('Dependency update failed.', async () => {
				if (node?.kind !== 'dependency' && node?.kind !== 'update') {
					throw new Error('Select a dependency from Cargo Deps first.');
				}
				await model.whenSettled();
				const plan = await prepareDependencyUpdates(model, node.kind === 'update' ? node.requests : [node]);
				const change = versionChange(node.health);
				if (change !== 'compatible') {
					const warning = change === 'outside range' ? 'Outside the current requirement; may include breaking changes.'
						: change === 'prerelease' ? 'Prerelease version; may be unstable.' : 'Compatibility with the current requirement is unknown.';
					const selected = await vscode.window.showWarningMessage(`Update ${node.health.dependency.name} to ${node.health.latestVersion}?`, {
						modal: true, detail: `${warning} Current requirement: ${node.health.dependency.versionRequirement}. Shared declarations affect all their users, even outside the selected scope. Changes remain unsaved for review.`,
					}, 'Update');
					if (selected !== 'Update') { return; }
				}
				await applyDependencyUpdates(model, plan);
				this.updated(plan.count);
			})),
			vscode.commands.registerCommand('cargo-deps.updateVisible', (node?: DependencyTreeNode) => this.run('Dependency updates failed.', async () => {
				await model.whenSettled();
				if (node && (node.kind !== 'crate' || model.getSnapshot(node.snapshot.root) !== node.snapshot)) {
					throw new Error('Select a current crate from Cargo Deps first.');
				}
				const requests = updates.getUpdateRequests(node?.snapshot.root);
				if (!requests.length) {
					void vscode.window.showInformationMessage('No dependency requirements need updating in this scope.');
					return;
				}
				const plan = await prepareDependencyUpdates(model, requests);
				const kinds = [...new Set(requests.map(request => versionChange(request.health)))];
				const choice = await vscode.window.showWarningMessage(`Update ${plan.count} dependency requirement(s) to latest?`, {
					modal: true,
					detail: `Update types: ${kinds.join(', ')}. Updates outside the current range may include breaking changes. Shared declarations affect all their users, even outside the selected scope, and are updated once. Changes remain unsaved for review; Cargo.lock is not modified.`,
				}, 'Update');
				if (choice === 'Update') {
					await applyDependencyUpdates(model, plan);
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
