import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from './analysis';
import { parseDependencies, sameDependencySource } from './manifest';
import { isCargoManifest } from './updates';
import type { AnalysisSnapshot } from '../types';

interface PanelState {
	base: AnalysisSnapshot;
	snapshot: AnalysisSnapshot;
	workspace?: PanelState;
	pending: boolean;
	problem?: string;
}

export class PanelModel implements vscode.Disposable {
	private states = new Map<string, PanelState>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly subscriptions: vscode.Disposable[];
	private generation = 0;
	private working: Promise<void> = Promise.resolve();
	private updating = false;
	private disposed = false;

	constructor(private readonly analysis: DependencyAnalysisService) {
		const changed = (document: vscode.TextDocument, contentChanged = false) => {
			if (isCargoManifest(document) && analysis.getSnapshot(path.dirname(document.uri.fsPath))) {
				const snapshot = this.getSnapshots().find(candidate => candidate.root === path.dirname(document.uri.fsPath));
				if (contentChanged || snapshot?.contents !== document.getText()) {
					this.refresh();
				}
			}
		};
		this.subscriptions = [
			analysis.onDidChange(() => this.refresh()),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.contentChanges.length) {
					changed(event.document, true);
				}
			}),
			vscode.workspace.onDidOpenTextDocument(changed),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (isCargoManifest(document) && analysis.getSnapshot(path.dirname(document.uri.fsPath))) {
					this.refresh();
				}
			}),
		];
		this.refresh();
	}

	getSnapshots(): readonly AnalysisSnapshot[] {
		return this.analysis.getSnapshots().map(base => {
			const state = this.states.get(base.root);
			return state?.base === base ? state.snapshot : base;
		});
	}

	getSnapshot(root: string): AnalysisSnapshot | undefined {
		if (this.updating || this.problem(root)) {
			return undefined;
		}
		const base = this.analysis.getSnapshot(root);
		const snapshot = this.getSnapshots().find(candidate => candidate.root === root);
		const document = vscode.workspace.textDocuments.find(candidate => isCargoManifest(candidate) && path.dirname(candidate.uri.fsPath) === root);
		return base && snapshot && (!document || document.getText() === snapshot.contents) ? snapshot : undefined;
	}

	isPending(root: string): boolean {
		return this.states.get(root)?.pending === true;
	}

	problem(root: string): string | undefined {
		const state = this.states.get(root);
		return state?.base === this.analysis.getSnapshot(root) ? state?.problem : undefined;
	}

	async whenSettled(): Promise<void> {
		let current: Promise<void>;
		do {
			current = this.working;
			await current;
		} while (current !== this.working);
	}

	private refresh(): void {
		const generation = ++this.generation;
		this.updating = true;
		this.emitter.fire();
		this.working = this.rebuild(generation);
	}

	private async rebuild(generation: number): Promise<void> {
		const bases = new Map(this.analysis.getSnapshots().map(snapshot => [snapshot.root, snapshot]));
		const contents = new Map(vscode.workspace.textDocuments.filter(isCargoManifest)
			.map(document => [path.dirname(document.uri.fsPath), document.getText()]));
		const next = new Map<string, Promise<PanelState>>();
		const build = (base: AnalysisSnapshot): Promise<PanelState> => {
			let pending = next.get(base.root);
			if (!pending) {
				pending = (async () => {
					const parent = base.workspaceRoot && base.workspaceRoot !== base.root ? bases.get(base.workspaceRoot) : undefined;
					const workspace = parent ? await build(parent) : undefined;
					const text = contents.get(base.root) ?? base.contents;
					const previous = this.states.get(base.root);
					if (previous?.base === base && previous.snapshot.contents === text && previous.workspace === workspace) {
						return previous;
					}
					if (text === base.contents && !workspace?.pending && !workspace?.problem) {
						return { base, snapshot: base, workspace, pending: false };
					}
					try {
						if (workspace?.problem) {
							throw new Error('Fix the workspace manifest before editing inherited dependencies.');
						}
						let context = workspace?.snapshot.dependencies.map(health => health.dependency) ?? base.workspaceDependencies;
						let parsed = await parseDependencies(text, context);
						if (base.workspaceRoot === base.root && parsed.some(dependency => dependency.workspace === 'inherited')) {
							// A root package can inherit its own unsaved workspace declarations.
							context = parsed.filter(dependency => dependency.workspace === 'declaration');
							parsed = await parseDependencies(text, context);
						}
						const dependencies = parsed.map(dependency => {
							const previousHealth = base.dependencies.find(health => sameDependencySource(health.dependency, dependency));
							return previousHealth ? { ...previousHealth, dependency } : {
								dependency, installedVersion: '', latestVersion: '', versions: [], advisories: [], auditAvailable: false,
							};
						});
						return {
							base, workspace, pending: true,
							snapshot: { ...base, contents: text, dependencies, workspaceDependencies: context },
						};
					} catch (error) {
						return {
							base, workspace, pending: true,
							snapshot: { ...base, contents: text, dependencies: [] },
							problem: error instanceof Error ? error.message : String(error),
						};
					}
				})();
				next.set(base.root, pending);
			}
			return pending;
		};
		const states = await Promise.all([...bases.values()].map(build));
		if (!this.disposed && generation === this.generation) {
			this.states = new Map(states.map(state => [state.base.root, state]));
			this.updating = false;
			this.emitter.fire();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.emitter.dispose();
	}
}
