import * as vscode from 'vscode';
import * as path from 'node:path';
import { CargoCommandError, CargoService } from './cargo';
import { CratesIoService } from './cratesIo';
import { isCratesIoDependency, parseManifest } from './manifest';
import type { ParsedManifest } from './manifest';
import { AnalysisProgressTracker } from './progress';
import type { AnalysisStepId } from './progress';
import type { Advisory, AnalysisSnapshot, CargoAuditEntry, CargoOutdatedEntry, CrateReleaseInfo, Dependency, DependencyHealth } from '../types';

class AnalysisBatch {
	constructor(readonly signal?: AbortSignal) {}

	readonly audits = new Map<string, Promise<CargoAuditEntry[]>>();
	readonly outdated = new Map<string, Promise<CargoOutdatedEntry[]>>();
	readonly workspaces = new Map<string, Promise<ParsedManifest & { contents: string }>>();
	readonly releases = new Map<string, Promise<CrateReleaseInfo>>();
	readonly snapshots = new Map<string, { previous?: AnalysisSnapshot; current?: AnalysisSnapshot }>();
}

export class DependencyAnalysisService {
	private readonly snapshots = new Map<string, AnalysisSnapshot>();
	private readonly inFlight = new Map<string, { operation: Promise<void>; batch: AnalysisBatch }>();
	private readonly warned = new Set<string>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly analysisEmitter = new vscode.EventEmitter<AnalysisSnapshot>();
	readonly onDidAnalyze = this.analysisEmitter.event;
	private readonly progress = new AnalysisProgressTracker();
	readonly onDidProgress = this.progress.onDidChange;
	private readonly auditFailures = new Map<string, string>();
	private readonly outdatedFailures = new Map<string, string>();

	constructor(
		private readonly cargo = new CargoService(),
		private readonly cratesIo = new CratesIoService(),
	) {}

	dispose(): void {
		this.changeEmitter.dispose();
		this.analysisEmitter.dispose();
		this.progress.dispose();
	}

	getSnapshot(root: string): AnalysisSnapshot | undefined {
		return this.snapshots.get(root);
	}

	forget(root: string): void {
		this.snapshots.delete(root);
		this.changeEmitter.fire();
	}

	refresh(
		root: string,
		batch = new AnalysisBatch(),
		inBatch = false,
	): Promise<void> {
		batch.signal?.throwIfAborted();
		const pending = this.inFlight.get(root);
		if (pending && pending.batch.signal === batch.signal) {
			return pending.operation;
		}
		if (!inBatch) {
			this.auditFailures.clear();
			this.outdatedFailures.clear();
			this.progress.begin(1);
			this.progress.manifest(root);
		}

		const operation = this.analyze(root, batch).then(() => {
			batch.signal?.throwIfAborted();
			if (!inBatch) {
				this.progress.manifestCompleted();
				this.progress.finish();
			}
		}, error => {
			batch.signal?.throwIfAborted();
			if (!inBatch) {
				this.progress.finish(errorMessage(error));
			}
			throw error;
		}).finally(() => {
			if (this.inFlight.get(root)?.operation === operation) {
				this.inFlight.delete(root);
			}
		});
		this.inFlight.set(root, { operation, batch });
		return operation;
	}

	async refreshAll(roots: string[], signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const batch = new AnalysisBatch(signal);
		const uniqueRoots = [...new Set(roots)];
		const rollback = () => {
			for (const [root, { previous, current }] of batch.snapshots) {
				if (this.snapshots.get(root) !== current) {
					continue;
				}
				if (previous) {
					this.snapshots.set(root, previous);
				} else {
					this.snapshots.delete(root);
				}
				this.analysisEmitter.fire(previous ?? { root, contents: '', dependencies: [], updatedAt: Date.now() });
			}
			this.changeEmitter.fire();
		};
		signal?.addEventListener('abort', rollback, { once: true });
		this.auditFailures.clear();
		this.outdatedFailures.clear();
		this.progress.begin(uniqueRoots.length);
		try {
			for (const root of uniqueRoots) {
				signal?.throwIfAborted();
				this.progress.manifest(root);
				await this.refresh(root, batch, true);
				signal?.throwIfAborted();
				this.progress.manifestCompleted();
			}
			signal?.throwIfAborted();
			this.progress.finish();
		} catch (error) {
			signal?.throwIfAborted();
			this.progress.finish(errorMessage(error));
			throw error;
		} finally {
			signal?.removeEventListener('abort', rollback);
		}
	}

	private publishSnapshot(root: string, snapshot: AnalysisSnapshot | undefined, batch: AnalysisBatch): void {
		batch.signal?.throwIfAborted();
		if (!batch.snapshots.has(root)) {
			batch.snapshots.set(root, { previous: this.snapshots.get(root) });
		}
		batch.snapshots.get(root)!.current = snapshot;
		if (snapshot) {
			this.snapshots.set(root, snapshot);
		} else {
			this.snapshots.delete(root);
		}
		this.analysisEmitter.fire(snapshot ?? { root, contents: '', dependencies: [], updatedAt: Date.now() });
		this.changeEmitter.fire();
	}

	private async readManifest(root: string, workspaceDependencies: Dependency[] = []): Promise<ParsedManifest & { contents: string }> {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, 'Cargo.toml')));
		const contents = new TextDecoder().decode(bytes);
		return { contents, ...await parseManifest(contents, workspaceDependencies) };
	}

	private async analyze(root: string, batch: AnalysisBatch): Promise<void> {
		const signal = batch.signal;
		signal?.throwIfAborted();
		const manifest = vscode.Uri.file(path.join(root, 'Cargo.toml'));
		let dependencies: Dependency[];
		let contents: string;
		let workspaceRoot: string;
		let workspaceDependencies: Dependency[];
		let packageName: string | undefined;
		this.progress.update('manifest', { status: 'running', active: [manifest.fsPath] });
		try {
			workspaceRoot = await this.cargo.workspaceRoot(root, signal);
			signal?.throwIfAborted();
			let workspace = batch.workspaces.get(workspaceRoot);
			if (!workspace) {
				workspace = this.readManifest(workspaceRoot);
				batch.workspaces.set(workspaceRoot, workspace);
			}
			const workspaceManifest = await workspace;
			signal?.throwIfAborted();
			workspaceDependencies = workspaceManifest.dependencies;
			({ contents, dependencies, packageName } = workspaceRoot === root
				? workspaceManifest : await this.readManifest(root, workspaceDependencies));
			signal?.throwIfAborted();
			this.progress.update('manifest', { status: 'completed', completed: 1, active: [], detail: `${dependencies.length} dependencies` });
		} catch (error) {
			signal?.throwIfAborted();
			this.progress.error('manifest', errorMessage(error));
			for (const step of ['audit', 'outdated', 'tree', 'crates'] as const) {
				this.progress.update(step, { status: 'skipped', detail: 'Manifest unavailable' });
			}
			this.publishSnapshot(root, undefined, batch);
			this.warnOnce('manifest', `Unable to read Cargo.toml: ${errorMessage(error)}`);
			return;
		}

		let audit = batch.audits.get(workspaceRoot);
		if (!audit) {
			audit = this.runCargoStep('cargo-audit', workspaceRoot, () => this.cargo.audit(workspaceRoot, signal), [], 'audit', signal);
			batch.audits.set(workspaceRoot, audit);
		} else {
			const failure = this.auditFailures.get(workspaceRoot);
			this.progress.update('audit', {
				status: failure ? 'failed' : 'completed', completed: failure ? 0 : 1,
				detail: failure ? `Workspace audit unavailable: ${failure}` : `Reused workspace audit: ${workspaceRoot}`,
			});
		}
		let workspaceOutdated = batch.outdated.get(workspaceRoot);
		if (!workspaceOutdated) {
			workspaceOutdated = this.runCargoStep(
				'cargo-outdated',
				workspaceRoot,
				() => this.cargo.outdated(workspaceRoot, true, signal),
				[],
				'outdated',
				signal,
			);
			batch.outdated.set(workspaceRoot, workspaceOutdated);
		} else {
			const failure = this.outdatedFailures.get(workspaceRoot);
			this.progress.update('outdated', {
				status: failure ? 'failed' : 'completed', completed: failure ? 0 : 1,
				detail: failure ? `Workspace outdated check unavailable: ${failure}` : `Reused workspace outdated check: ${workspaceRoot}`,
			});
		}
		const [auditEntries, outdatedEntries] = await Promise.all([audit, workspaceOutdated]);
		signal?.throwIfAborted();
		const memberOutdated = outdatedEntries.some(entry => entry.crateName)
			? outdatedEntries.filter(entry => entry.crateName === packageName)
			: outdatedEntries;
		const advisories = await this.attachAdvisories(root, dependencies, auditEntries, signal);
		signal?.throwIfAborted();

		const crateNames = [...new Set(dependencies.filter(isCratesIoDependency).map(dependency => dependency.packageName))];
		const releases = new Map<string, CrateReleaseInfo>();
		let cratesCompleted = 0;
		let cratesFailed = 0;
		this.progress.update('crates', {
			status: crateNames.length ? 'running' : 'skipped', total: crateNames.length,
			detail: crateNames.length ? undefined : 'No registry dependencies',
		});
		await Promise.all(crateNames.map(async crateName => {
			signal?.throwIfAborted();
			this.progress.lookup(crateName, true);
			try {
				let release = batch.releases.get(crateName);
				if (!release) {
					release = this.cratesIo.getReleaseInfo(crateName, event => {
						if (!signal?.aborted) {
							this.progress.request(event);
						}
					}, signal);
					batch.releases.set(crateName, release);
				} else {
					this.progress.request({ kind: 'shared' });
				}
				releases.set(crateName, await release);
				signal?.throwIfAborted();
			} catch (error) {
				signal?.throwIfAborted();
				cratesFailed++;
				this.progress.recordError(`${crateName}: ${errorMessage(error)}`);
				this.warnOnce('crates.io', `Unable to retrieve crate versions from crates.io: ${errorMessage(error)}`);
			} finally {
				if (!signal?.aborted) {
					this.progress.lookup(crateName, false);
					cratesCompleted++;
					this.progress.update('crates', { completed: cratesCompleted });
				}
			}
		}));
		signal?.throwIfAborted();
		this.progress.update('crates', {
			status: cratesFailed ? 'failed' : crateNames.length ? 'completed' : 'skipped', active: [],
			detail: cratesFailed ? `${cratesFailed} crate lookups failed` : crateNames.length ? 'Release lookups complete' : 'No registry dependencies',
		});

		const health = dependencies.map(dependency => {
			const releaseInfo = isCratesIoDependency(dependency) ? releases.get(dependency.packageName) : undefined;

			const outdated = findOutdatedEntry(memberOutdated, dependency);
			return {
				dependency,
				installedVersion: outdated?.project || cleanVersion(dependency.versionRequirement),
				latestVersion: isCratesIoDependency(dependency) ? outdated?.latest || releaseInfo?.latestVersion || '' : '',
				versions: releaseInfo?.versions ?? [],
				documentationUrl: releaseInfo?.documentationUrl,
				repositoryUrl: releaseInfo?.repositoryUrl,
				advisories: advisories.get(dependency.name) ?? [],
				auditAvailable: !this.auditFailures.has(workspaceRoot),
			} satisfies DependencyHealth;
		});

		const snapshot = { root, contents, dependencies: health, workspaceDependencies, updatedAt: Date.now() };
		this.publishSnapshot(root, snapshot, batch);
	}

	private async attachAdvisories(
		root: string,
		dependencies: Dependency[],
		entries: CargoAuditEntry[],
		signal?: AbortSignal,
	): Promise<Map<string, Advisory[]>> {
		const result = new Map<string, Advisory[]>();
		const transitive = new Set(entries
			.filter(entry => !dependencies.some(dependency => dependency.packageName === entry.packageName))
			.map(entry => `${entry.packageName}@${entry.packageVersion}`));
		const trees = new Map<string, string | undefined>();
		let treesCompleted = 0;
		let treesFailed = 0;
		let absentPackages = 0;
		this.progress.update('tree', {
			status: transitive.size ? 'running' : 'skipped', total: transitive.size,
			detail: transitive.size ? undefined : 'No transitive advisories to trace',
		});
		for (const entry of entries) {
			signal?.throwIfAborted();
			const directMatches = dependencies.filter(dependency => dependency.packageName === entry.packageName);
			let treePath: string | undefined;
			let affected = directMatches;

			if (affected.length === 0) {
				const specification = `${entry.packageName}@${entry.packageVersion}`;
				if (!trees.has(specification)) {
					trees.set(specification, undefined);
					this.progress.update('tree', { active: [specification] });
					try {
						const tree = await this.cargo.inverseTree(root, entry.packageName, entry.packageVersion, signal);
						signal?.throwIfAborted();
						trees.set(specification, tree);
						if (!tree.trim()) {
							absentPackages++;
						}
					} catch (error) {
						signal?.throwIfAborted();
						treesFailed++;
						this.progress.recordError(`cargo tree (${entry.packageName}): ${errorMessage(error)}`);
					} finally {
						if (!signal?.aborted) {
							treesCompleted++;
							this.progress.update('tree', { completed: treesCompleted, active: [] });
						}
					}
				}
				treePath = trees.get(specification);
				if (!treePath) {
					continue;
				}
				const packages = new Set(treePath.split(/\r?\n/).flatMap(line => {
					const match = /^\d+([A-Za-z0-9_-]+) v/.exec(line.trim());
					return match ? [match[1]] : [];
				}));
				affected = dependencies.filter(dependency => packages.has(dependency.packageName));
			}

			for (const dependency of affected) {
				const advisory = { ...entry, treePath };
				const list = result.get(dependency.name) ?? [];
				list.push(advisory);
				result.set(dependency.name, list);
			}
		}
		this.progress.update('tree', {
			status: treesFailed ? 'failed' : transitive.size ? 'completed' : 'skipped',
			detail: treesFailed ? `${treesFailed} dependency traces failed`
				: absentPackages ? `Dependency traces complete; ${absentPackages} package(s) not used by this manifest`
					: transitive.size ? 'Dependency traces complete' : 'No transitive advisories to trace',
		});
		return result;
	}

	private async runCargoStep<T>(
		key: string,
		root: string,
		run: () => Promise<T>,
		fallback: T,
		step: AnalysisStepId,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		this.progress.update(step, { status: 'running', active: [root] });
		try {
			const value = await run();
			signal?.throwIfAborted();
			this.progress.update(step, { status: 'completed', completed: 1, active: [] });
			return value;
		} catch (error) {
			signal?.throwIfAborted();
			const message = errorMessage(error);
			if (step === 'audit') {
				this.auditFailures.set(root, message);
			} else if (step === 'outdated') {
				this.outdatedFailures.set(root, message);
			}
			this.progress.error(step, `${key}: ${message}`);
			const install = key === 'cargo-audit' ? 'cargo install cargo-audit' : 'cargo install cargo-outdated';
			const guidance = error instanceof CargoCommandError && error.missingTool
				? ` Install it with: ${install}.`
				: '';
			this.warnOnce(key, `${message}${guidance}`);
			return fallback;
		}
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		void vscode.window.showWarningMessage(message);
	}
}

function findOutdatedEntry(entries: CargoOutdatedEntry[], dependency: Dependency): CargoOutdatedEntry | undefined {
	return entries.find(entry => entry.name === dependency.packageName || entry.name === dependency.name);
}

function cleanVersion(version: string): string {
	return version.replace(/^[\s^~<>=v]+/, '').split(/[ ,]/)[0] ?? '';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}