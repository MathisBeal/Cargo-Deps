import * as vscode from 'vscode';
import * as path from 'node:path';
import { CargoCommandError, CargoService } from './cargo';
import { CratesIoService } from './cratesIo';
import { parseDependencies } from './manifest';
import type { Advisory, AnalysisSnapshot, CargoAuditEntry, CargoOutdatedEntry, CrateReleaseInfo, Dependency, DependencyHealth } from '../types';

export class DependencyAnalysisService {
	private readonly snapshots = new Map<string, AnalysisSnapshot>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly warned = new Set<string>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(
		private readonly cargo = new CargoService(),
		private readonly cratesIo = new CratesIoService(),
	) {}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	getSnapshot(root: string): AnalysisSnapshot | undefined {
		return this.snapshots.get(root);
	}

	refresh(root: string): Promise<void> {
		const pending = this.inFlight.get(root);
		if (pending) {
			return pending;
		}

		const operation = this.analyze(root).finally(() => {
			this.inFlight.delete(root);
		});
		this.inFlight.set(root, operation);
		return operation;
	}

	private async analyze(root: string): Promise<void> {
		const manifest = vscode.Uri.file(path.join(root, 'Cargo.toml'));
		let dependencies: Dependency[];
		try {
			const bytes = await vscode.workspace.fs.readFile(manifest);
			const workspaceRoot = await this.cargo.workspaceRoot(root);
			const workspaceDependencies = workspaceRoot === root
				? []
				: await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(workspaceRoot, 'Cargo.toml')))
					.then(workspaceBytes => parseDependencies(new TextDecoder().decode(workspaceBytes)));
			dependencies = await parseDependencies(new TextDecoder().decode(bytes), workspaceDependencies);
		} catch (error) {
			this.warnOnce('manifest', `Unable to read Cargo.toml: ${errorMessage(error)}`);
			return;
		}

		const [auditEntries, outdatedEntries] = await Promise.all([
			this.runCargoStep('cargo-audit', root, () => this.cargo.audit(root), []),
			this.runCargoStep('cargo-outdated', root, () => this.cargo.outdated(root), []),
		]);
		const advisories = await this.attachAdvisories(root, dependencies, auditEntries);

		const health = await Promise.all(dependencies.map(async dependency => {
			let releaseInfo: CrateReleaseInfo = { latestVersion: '', versions: [] };
			if (!dependency.localPath) {
				try {
					releaseInfo = await this.cratesIo.getReleaseInfo(dependency.packageName);
				} catch (error) {
					this.warnOnce('crates.io', `Unable to retrieve crate versions from crates.io: ${errorMessage(error)}`);
				}
			}

			const outdated = findOutdatedEntry(outdatedEntries, dependency);
			return {
				dependency,
				installedVersion: outdated?.project || cleanVersion(dependency.versionRequirement),
				latestVersion: dependency.localPath ? '' : outdated?.latest || releaseInfo.latestVersion,
				versions: releaseInfo.versions,
				advisories: advisories.get(dependency.name) ?? [],
			} satisfies DependencyHealth;
		}));

		this.snapshots.set(root, { root, dependencies: health, updatedAt: Date.now() });
		this.changeEmitter.fire();
	}

	private async attachAdvisories(
		root: string,
		dependencies: Dependency[],
		entries: CargoAuditEntry[],
	): Promise<Map<string, Advisory[]>> {
		const result = new Map<string, Advisory[]>();
		for (const entry of entries) {
			const directMatches = dependencies.filter(dependency => dependency.packageName === entry.packageName);
			let treePath: string | undefined;
			let affected = directMatches;

			if (affected.length === 0) {
				try {
					treePath = await this.cargo.inverseTree(root, entry.packageName, entry.packageVersion);
					affected = dependencies.filter(dependency =>
						treePath?.includes(`${dependency.packageName} v`) || treePath?.includes(`${dependency.name} v`),
					);
				} catch {
					continue;
				}
			}

			for (const dependency of affected) {
				const advisory = { ...entry, treePath };
				const list = result.get(dependency.name) ?? [];
				list.push(advisory);
				result.set(dependency.name, list);
			}
		}
		return result;
	}

	private async runCargoStep<T>(
		key: string,
		root: string,
		run: () => Promise<T>,
		fallback: T,
	): Promise<T> {
		try {
			return await run();
		} catch (error) {
			const message = errorMessage(error);
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