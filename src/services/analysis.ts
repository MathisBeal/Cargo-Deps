import * as vscode from 'vscode';
import * as path from 'node:path';
import { CargoCommandError, CargoService } from './cargo';
import { CratesIoService } from './cratesIo';
import { parseDependencies } from './manifest';
import { AnalysisProgressTracker } from './progress';
import type { AnalysisStepId } from './progress';
import type { Advisory, AnalysisSnapshot, CargoAuditEntry, CargoOutdatedEntry, CrateReleaseInfo, Dependency, DependencyHealth } from '../types';

export class DependencyAnalysisService {
	private readonly snapshots = new Map<string, AnalysisSnapshot>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly warned = new Set<string>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly analysisEmitter = new vscode.EventEmitter<AnalysisSnapshot>();
	readonly onDidAnalyze = this.analysisEmitter.event;
	private readonly progress = new AnalysisProgressTracker();
	readonly onDidProgress = this.progress.onDidChange;
	private readonly auditFailures = new Map<string, string>();

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

	refresh(root: string, audits = new Map<string, Promise<CargoAuditEntry[]>>(), inBatch = false): Promise<void> {
		const pending = this.inFlight.get(root);
		if (pending) {
			return pending;
		}
		if (!inBatch) {
			this.auditFailures.clear();
			this.progress.begin(1);
			this.progress.manifest(root);
		}

		const operation = this.analyze(root, audits).then(() => {
			if (!inBatch) {
				this.progress.manifestCompleted();
				this.progress.finish();
			}
		}, error => {
			if (!inBatch) {
				this.progress.finish(errorMessage(error));
			}
			throw error;
		}).finally(() => {
			this.inFlight.delete(root);
		});
		this.inFlight.set(root, operation);
		return operation;
	}

	async refreshAll(roots: string[]): Promise<void> {
		const audits = new Map<string, Promise<CargoAuditEntry[]>>();
		const uniqueRoots = [...new Set(roots)];
		this.auditFailures.clear();
		this.progress.begin(uniqueRoots.length);
		try {
			for (const root of uniqueRoots) {
				this.progress.manifest(root);
				await this.refresh(root, audits, true);
				this.progress.manifestCompleted();
			}
			this.progress.finish();
		} catch (error) {
			this.progress.finish(errorMessage(error));
			throw error;
		}
	}

	private async analyze(root: string, audits: Map<string, Promise<CargoAuditEntry[]>>): Promise<void> {
		const manifest = vscode.Uri.file(path.join(root, 'Cargo.toml'));
		let dependencies: Dependency[];
		let contents: string;
		let workspaceRoot: string;
		this.progress.update('manifest', { status: 'running', active: [manifest.fsPath] });
		try {
			const bytes = await vscode.workspace.fs.readFile(manifest);
			contents = new TextDecoder().decode(bytes);
			workspaceRoot = await this.cargo.workspaceRoot(root);
			const workspaceDependencies = workspaceRoot === root
				? []
				: await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(workspaceRoot, 'Cargo.toml')))
					.then(workspaceBytes => parseDependencies(new TextDecoder().decode(workspaceBytes)));
			dependencies = await parseDependencies(contents, workspaceDependencies);
			this.progress.update('manifest', { status: 'completed', completed: 1, active: [], detail: `${dependencies.length} dependencies` });
		} catch (error) {
			this.progress.error('manifest', errorMessage(error));
			for (const step of ['audit', 'outdated', 'tree', 'crates'] as const) {
				this.progress.update(step, { status: 'skipped', detail: 'Manifest unavailable' });
			}
			this.snapshots.delete(root);
			this.analysisEmitter.fire({ root, contents: '', dependencies: [], updatedAt: Date.now() });
			this.changeEmitter.fire();
			this.warnOnce('manifest', `Unable to read Cargo.toml: ${errorMessage(error)}`);
			return;
		}

		let audit = audits.get(workspaceRoot);
		if (!audit) {
			audit = this.runCargoStep('cargo-audit', workspaceRoot, () => this.cargo.audit(workspaceRoot), [], 'audit');
			audits.set(workspaceRoot, audit);
		} else {
			const failure = this.auditFailures.get(workspaceRoot);
			this.progress.update('audit', {
				status: failure ? 'failed' : 'completed', completed: failure ? 0 : 1,
				detail: failure ? `Workspace audit unavailable: ${failure}` : `Reused workspace audit: ${workspaceRoot}`,
			});
		}
		const [auditEntries, outdatedEntries] = await Promise.all([
			audit,
			this.runCargoStep('cargo-outdated', root, () => this.cargo.outdated(root), [], 'outdated'),
		]);
		const advisories = await this.attachAdvisories(root, dependencies, auditEntries);

		const crateNames = [...new Set(dependencies.filter(dependency => !dependency.localPath).map(dependency => dependency.packageName))];
		const releases = new Map<string, CrateReleaseInfo>();
		let cratesCompleted = 0;
		let cratesFailed = 0;
		this.progress.update('crates', {
			status: crateNames.length ? 'running' : 'skipped', total: crateNames.length,
			detail: crateNames.length ? undefined : 'No registry dependencies',
		});
		await Promise.all(crateNames.map(async crateName => {
			this.progress.lookup(crateName, true);
			try {
				releases.set(crateName, await this.cratesIo.getReleaseInfo(crateName, event => this.progress.request(event)));
			} catch (error) {
				cratesFailed++;
				this.progress.recordError(`${crateName}: ${errorMessage(error)}`);
				this.warnOnce('crates.io', `Unable to retrieve crate versions from crates.io: ${errorMessage(error)}`);
			} finally {
				this.progress.lookup(crateName, false);
				cratesCompleted++;
				this.progress.update('crates', { completed: cratesCompleted });
			}
		}));
		this.progress.update('crates', {
			status: cratesFailed ? 'failed' : crateNames.length ? 'completed' : 'skipped', active: [],
			detail: cratesFailed ? `${cratesFailed} crate lookups failed` : crateNames.length ? 'Release lookups complete' : 'No registry dependencies',
		});

		const health = dependencies.map(dependency => {
			const releaseInfo = releases.get(dependency.packageName);

			const outdated = findOutdatedEntry(outdatedEntries, dependency);
			return {
				dependency,
				installedVersion: outdated?.project || cleanVersion(dependency.versionRequirement),
				latestVersion: dependency.localPath ? '' : outdated?.latest || releaseInfo?.latestVersion || '',
				versions: releaseInfo?.versions ?? [],
				advisories: advisories.get(dependency.name) ?? [],
			} satisfies DependencyHealth;
		});

		const snapshot = { root, contents, dependencies: health, updatedAt: Date.now() };
		this.snapshots.set(root, snapshot);
		this.analysisEmitter.fire(snapshot);
		this.changeEmitter.fire();
	}

	private async attachAdvisories(
		root: string,
		dependencies: Dependency[],
		entries: CargoAuditEntry[],
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
			const directMatches = dependencies.filter(dependency => dependency.packageName === entry.packageName);
			let treePath: string | undefined;
			let affected = directMatches;

			if (affected.length === 0) {
				const specification = `${entry.packageName}@${entry.packageVersion}`;
				if (!trees.has(specification)) {
					trees.set(specification, undefined);
					this.progress.update('tree', { active: [specification] });
					try {
						const tree = await this.cargo.inverseTree(root, entry.packageName, entry.packageVersion);
						trees.set(specification, tree);
						if (!tree.trim()) {
							absentPackages++;
						}
					} catch (error) {
						treesFailed++;
						this.progress.recordError(`cargo tree (${entry.packageName}): ${errorMessage(error)}`);
					} finally {
						treesCompleted++;
						this.progress.update('tree', { completed: treesCompleted, active: [] });
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
	): Promise<T> {
		this.progress.update(step, { status: 'running', active: [root] });
		try {
			const value = await run();
			this.progress.update(step, { status: 'completed', completed: 1, active: [] });
			return value;
		} catch (error) {
			const message = errorMessage(error);
			if (step === 'audit') {
				this.auditFailures.set(root, message);
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