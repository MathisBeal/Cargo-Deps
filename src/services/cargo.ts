import { execFile } from 'node:child_process';
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
	async audit(root: string): Promise<CargoAuditEntry[]> {
		const workspaceRoot = await this.findWorkspaceRoot(root);
		const data = await this.runJson(workspaceRoot, ['audit', '--json'], 'cargo-audit');
		return parseAuditReport(data);
	}

	async outdated(root: string): Promise<CargoOutdatedEntry[]> {
		const data = await this.runJson(root, ['outdated', '--format', 'json'], 'cargo-outdated');
		const rows: CargoOutdatedEntry[] = [];
		const visit = (value: unknown) => {
			if (Array.isArray(value)) {
				value.forEach(visit);
				return;
			}
			if (!value || typeof value !== 'object') {
				return;
			}
			const row = value as Record<string, unknown>;
			const name = stringValue(row.name ?? row.Name);
			const project = stringValue(row.project ?? row.Project);
			const latest = stringValue(row.latest ?? row.Latest);
			if (name && (project || latest)) {
				rows.push({ name, project, latest });
			}
			Object.values(row).forEach(visit);
		};
		visit(data);
		return rows;
	}

	async inverseTree(root: string, packageName: string, version: string): Promise<string> {
		return this.runText(root, ['tree', '--invert', `${packageName}@${version}`, '--prefix', 'depth']);
	}

	private async findWorkspaceRoot(root: string): Promise<string> {
		try {
			const manifest = await this.runText(root, ['locate-project', '--workspace', '--message-format', 'plain']);
			return path.dirname(manifest.trim().replace(/^"|"$/g, ''));
		} catch {
			return root;
		}
	}

	private async runJson(root: string, args: string[], toolName: string): Promise<unknown> {
		const output = await this.runText(root, args, toolName);
		try {
			return JSON.parse(output) as unknown;
		} catch {
			throw new CargoCommandError(`${toolName} returned invalid JSON.`, false);
		}
	}

	private async runText(root: string, args: string[], toolName = 'cargo'): Promise<string> {
		try {
			const result = await execFileAsync('cargo', args, {
				cwd: root,
				encoding: 'utf8',
				timeout: 120_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			return result.stdout;
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
			const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
			if (failure.stdout?.trim()) {
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

export function parseAuditReport(data: unknown): CargoAuditEntry[] {
	const report = objectValue(data);
	const vulnerabilities = objectValue(report.vulnerabilities);
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