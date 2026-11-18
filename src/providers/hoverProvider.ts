import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from '../services/analysis';
import type { DependencyHealth } from '../types';
import { isOutdated } from './hintsProvider';
import { documentHealth, selectionFor, SET_VERSION_COMMAND, versionEdit } from '../services/updates';
import { isCratesIoDependency } from '../services/manifest';

export class CargoHoverProvider implements vscode.HoverProvider {
	constructor(private readonly analysis: DependencyAnalysisService) {}

	async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		if (path.basename(document.uri.fsPath) !== 'Cargo.toml') {
			return undefined;
		}

		const documentVersion = document.version;
		const health = (await documentHealth(document, this.analysis)).find(item => item.dependency.line === position.line
			|| (item.dependency.versionRange && document.positionAt(item.dependency.versionRange.start).line === position.line));
		if (!health || document.version !== documentVersion) {
			return undefined;
		}

		return new vscode.Hover(buildDependencyHover(health, document), document.lineAt(position.line).range);
	}
}

export function buildDependencyHover(health: DependencyHealth, document: vscode.TextDocument): vscode.MarkdownString {
	const { dependency, installedVersion, latestVersion, advisories, versions } = health;
	const isLocal = Boolean(dependency.localPath);
	const registryDependency = isCratesIoDependency(dependency);
	const sourceLabel = isLocal ? 'local' : dependency.git ? 'Git' : `registry: ${dependency.registry}`;
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = { enabledCommands: [SET_VERSION_COMMAND] };
	const versionLabel = (version: string) => {
		if (!vscode.workspace.isTrusted || !versionEdit(document, health, version)) {
			return inlineCode(version);
		}
		const args = encodeURIComponent(JSON.stringify([selectionFor(document, health, version)]));
		return `[${inlineCode(version)}](command:${SET_VERSION_COMMAND}?${args} "Use this version")`;
	};
	markdown.appendMarkdown(`### ${escapeMarkdown(dependency.name)}\n\n`);
	const resources = registryDependency ? [
		...resourceLink('Documentation', health.documentationUrl),
		...resourceLink('Repository', health.repositoryUrl),
		...resourceLink('crates.io', `https://crates.io/crates/${encodeURIComponent(dependency.packageName)}`),
	] : resourceLink('Repository', dependency.git);
	if (resources.length) {
		markdown.appendMarkdown(`${resources.join(' · ')}\n\n`);
	}
	markdown.appendMarkdown(`Installed: ${inlineCode(installedVersion || dependency.versionRequirement)} · Latest: ${!registryDependency ? inlineCode(sourceLabel) : latestVersion ? versionLabel(latestVersion) : inlineCode('unknown')}\n\n`);
	markdown.appendMarkdown(`**Status:** ${isLocal ? `Local path dependency (${inlineCode(dependency.localPath ?? '')})` : !registryDependency ? 'Not checked on crates.io' : isOutdated(installedVersion, latestVersion) ? 'Update available' : 'Up to date or unknown'}\n\n`);

	markdown.appendMarkdown('#### Security advisories & warnings\n');
	if (health.auditAvailable === false) {
		markdown.appendMarkdown('Security analysis unavailable: `cargo audit` failed. See Cargo Deps output for details.\n');
	} else if (advisories.length === 0) {
		markdown.appendMarkdown('No known vulnerabilities reported by `cargo audit`.\n');
	} else {
		for (const advisory of advisories) {
			markdown.appendMarkdown(`- **${escapeMarkdown(advisory.id)}**: ${escapeMarkdown(advisory.title)}`);
			if (advisory.severity) {
				markdown.appendMarkdown(` (${escapeMarkdown(advisory.severity)})`);
			}
			markdown.appendMarkdown('\n');
			if (advisory.treePath) {
				const dependencyPath = formatDependencyPath(advisory.treePath, dependency.packageName);
				if (dependencyPath) {
					markdown.appendMarkdown('\nShortest dependency path:\n');
					markdown.appendCodeblock(dependencyPath, 'text');
				} else {
					markdown.appendMarkdown('\nDependency path unavailable.\n');
				}
			}
		}
	}

	markdown.appendMarkdown('\n#### Recent releases\n');
	if (!registryDependency) {
		markdown.appendMarkdown('Release history is not checked on crates.io for this dependency source.\n');
	} else if (versions.length === 0) {
		markdown.appendMarkdown('Release history unavailable.\n');
	} else {
		for (const version of versions.slice(0, 10)) {
			const labels = [
				version.number === latestVersion ? 'latest' : '',
				version.number === installedVersion ? 'installed' : '',
				version.yanked ? 'yanked' : '',
			].filter(Boolean);
			markdown.appendMarkdown(`- ${version.yanked ? inlineCode(version.number) : versionLabel(version.number)}${labels.length ? ` (${labels.join(', ')})` : ''}\n`);
		}
	}
	return markdown;
}

export function formatDependencyPath(tree: string, packageName: string): string | undefined {
	const dependencies = new Map<string, Set<string>>();
	const names = new Map<string, string>();
	const ancestors: string[] = [];
	let affected: string | undefined;
	for (const line of tree.split(/\r?\n/)) {
		const entry = /^(\d+)([A-Za-z0-9_-]+) v([^\s]+)/.exec(line.trim());
		if (!entry) {
			continue;
		}
		const depth = Number(entry[1]);
		const node = `${entry[2]} v${entry[3]}`;
		names.set(node, entry[2]);
		if (depth === 0 && !affected) {
			affected = node;
		}
		if (depth > 0 && ancestors[depth - 1]) {
			const parents = dependencies.get(node) ?? new Set<string>();
			parents.add(ancestors[depth - 1]);
			dependencies.set(node, parents);
		}
		ancestors.length = depth;
		ancestors.push(node);
	}

	const queue = [...names].filter(([, name]) => name === packageName).map(([node]) => [node]);
	const visited = new Set(queue.map(chain => chain[0]));
	for (let index = 0; index < queue.length; index++) {
		const chain = queue[index];
		const node = chain[chain.length - 1];
		if (node === affected) {
			return chain.map((label, depth) => depth === 0 ? label : `${'  '.repeat(depth - 1)}└─ ${label}`).join('\n');
		}
		for (const parent of dependencies.get(node) ?? []) {
			if (!visited.has(parent)) {
				visited.add(parent);
				queue.push([...chain, parent]);
			}
		}
	}
	return undefined;
}

function resourceLink(label: string, value: string | undefined): string[] {
	if (!value || !URL.canParse(value)) {
		return [];
	}
	const url = new URL(value);
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
		return [];
	}
	return [`[${label}](<${url.href}>)`];
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function inlineCode(value: string): string {
	const runs = [...value.matchAll(/`+/g)].map(match => match[0].length);
	const fence = '`'.repeat(Math.max(1, ...runs) + 1);
	const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
	return `${fence}${padding}${value}${padding}${fence}`;
}