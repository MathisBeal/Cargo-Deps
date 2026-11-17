import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { CargoAuditEntry, CargoOutdatedEntry } from '../types';

const execFileAsync = promisify(execFile);

export class CargoCommandError extends Error {
	constructor(message: string, readonly missingTool: boolean) {
		super(message);
		this.name = 'CargoCommandError';
	}
}

export class CargoService {
	constructor(
		private readonly execute: (
			file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
		) => Promise<{ stdout: string; stderr: string }> = execFileAsync,
	) {}

	async audit(root: string, signal?: AbortSignal): Promise<CargoAuditEntry[]> {
		const workspaceRoot = await this.workspaceRoot(root, signal);
		const data = await this.runJson(workspaceRoot, ['audit', '--json'], 'cargo-audit', signal);
		return parseAuditReport(data);
	}

	async outdated(root: string, workspace = false, signal?: AbortSignal): Promise<CargoOutdatedEntry[]> {
		const args = ['outdated', '--format', 'json'];
		if (workspace) {
			args.push('--workspace');
		}
		const data = await this.runJson(root, args, 'cargo-outdated', signal);
		return parseOutdatedReport(data);
	}

	async inverseTree(root: string, packageName: string, version: string, signal?: AbortSignal): Promise<string> {
		const specification = `${packageName}@${version}`;
		try {
			return await this.runText(root, ['tree', '--invert', specification, '--prefix', 'depth'], 'cargo', signal);
		} catch (error) {
			if (error instanceof CargoCommandError && error.message.includes(`error: package ID specification \`${specification}\` did not match any packages`)) {
				return '';
			}
			throw error;
		}
	}

	async workspaceRoot(root: string, signal?: AbortSignal): Promise<string> {
		const manifest = await this.runText(root, ['locate-project', '--workspace', '--message-format', 'plain'], 'cargo', signal);
		return path.dirname(manifest.trim().replace(/^"|"$/g, ''));
	}

	private async runJson(root: string, args: string[], toolName: string, signal?: AbortSignal): Promise<unknown> {
		const output = await this.runText(root, args, toolName, signal);
		try {
			return parseCargoJson(output);
		} catch {
			throw new CargoCommandError(`${toolName} returned invalid JSON.`, false);
		}
	}

	private async runText(root: string, args: string[], toolName = 'cargo', signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		try {
			const result = await this.execute('cargo', args, {
				cwd: root,
				encoding: 'utf8',
				timeout: 120_000,
				maxBuffer: 10 * 1024 * 1024,
				signal,
			});
			signal?.throwIfAborted();
			return result.stdout;
		} catch (error) {
			signal?.throwIfAborted();
			const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
			const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
			// cargo-audit exits with 1 when a valid report contains vulnerabilities.
			if (toolName === 'cargo-audit' && failure.code === 1 && !failure.killed && !failure.signal && failure.stdout?.trim()) {
				return failure.stdout;
			}
			const missingTool = failure.code === 'ENOENT' || /no such command|not installed|could not find/i.test(output);
			const detail = output.trim() || failure.message || 'Unknown command failure';
			throw new CargoCommandError(
				missingTool ? `${toolName} is unavailable: ${detail}` : `${toolName} failed: ${detail}`,
				missingTool,
			);
		}
	}
}

export function parseOutdatedReport(data: unknown): CargoOutdatedEntry[] {
	const rows: CargoOutdatedEntry[] = [];
	const visit = (value: unknown, crateName?: string) => {
		if (Array.isArray(value)) {
			value.forEach(item => visit(item, crateName));
			return;
		}
		if (!value || typeof value !== 'object') {
			return;
		}
		const row = value as Record<string, unknown>;
		const owner = stringValue(row.crate_name ?? row.crateName, crateName);
		const name = stringValue(row.name ?? row.Name);
		const project = stringValue(row.project ?? row.Project);
		const latest = stringValue(row.latest ?? row.Latest);
		if (name && (project || latest)) {
			rows.push({ name, project, latest, crateName: owner || undefined });
		}
		Object.values(row).forEach(child => visit(child, owner || crateName));
	};
	visit(data);
	return rows;
}

export function parseCargoJson(output: string): unknown {
	try {
		return JSON.parse(output) as unknown;
	} catch {
		const lines = output.split(/\r?\n/).filter(line => line.trim().length > 0);
		if (lines.length === 0) {
			throw new Error('Empty JSON output');
		}
		return lines.map(line => JSON.parse(line) as unknown);
	}
}

export function parseAuditReport(data: unknown): CargoAuditEntry[] {
	const report = objectValue(data);
	const vulnerabilities = objectValue(report.vulnerabilities);
	if (!Array.isArray(vulnerabilities.list)) {
		throw new CargoCommandError('cargo-audit returned an invalid audit report.', false);
	}
	const vulnerabilityEntries = Array.isArray(vulnerabilities.list)
		? vulnerabilities.list.map(value => ({ value }))
		: [];
	const warningEntries = Object.entries(objectValue(report.warnings)).flatMap(([kind, group]) => {
		const entries = Array.isArray(group)
			? group
			: Array.isArray(objectValue(group).list)
				? objectValue(group).list as unknown[]
				: [];
		return entries.map(value => ({ value, kind }));
	});
	const allEntries: Array<{ value: unknown; kind?: string }> = [...vulnerabilityEntries, ...warningEntries];

	return allEntries.flatMap(({ value, kind }) => {
		const entry = objectValue(value);
		const advisory = objectValue(entry.advisory);
		const packageInfo = objectValue(entry.package);
		const packageName = stringValue(packageInfo.name);
		if (!packageName) {
			return [];
		}
		return [{
			packageName,
			packageVersion: stringValue(packageInfo.version),
			id: stringValue(advisory.id, 'Unknown advisory'),
			title: stringValue(advisory.title, 'No title available'),
			severity: stringValue(advisory.severity)
				|| stringValue(advisory.cvss)
				|| stringValue(advisory.informational)
				|| stringValue(entry.kind)
				|| kind,
		}];
	});
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ''): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}