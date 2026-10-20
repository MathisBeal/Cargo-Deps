import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from '../services/analysis';
import type { DependencyHealth } from '../types';
import { isOutdated } from './hintsProvider';

export class CargoHoverProvider implements vscode.HoverProvider {
	constructor(private readonly analysis: DependencyAnalysisService) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		if (path.basename(document.uri.fsPath) !== 'Cargo.toml') {
			return undefined;
		}

		const root = path.dirname(document.uri.fsPath);
		const health = this.analysis.getSnapshot(root)?.dependencies.find(item => item.dependency.line === position.line);
		if (!health) {
			return undefined;
		}

		return new vscode.Hover(buildHover(health), document.lineAt(position.line).range);
	}
}

function buildHover(health: DependencyHealth): vscode.MarkdownString {
	const { dependency, installedVersion, latestVersion, advisories, versions } = health;
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = false;
	markdown.appendMarkdown(`### ${escapeMarkdown(dependency.name)}\n\n`);
	markdown.appendMarkdown(`Installed: ${inlineCode(installedVersion || dependency.versionRequirement)} · Latest: ${inlineCode(latestVersion || 'unknown')}\n\n`);
	markdown.appendMarkdown(`**Status:** ${isOutdated(installedVersion, latestVersion) ? 'Update available' : 'Up to date or unknown'}\n\n`);

	markdown.appendMarkdown('#### Security advisories & warnings\n');
	if (advisories.length === 0) {
		markdown.appendMarkdown('No known vulnerabilities reported by `cargo audit`.\n');
	} else {
		for (const advisory of advisories) {
			markdown.appendMarkdown(`- **${escapeMarkdown(advisory.id)}**: ${escapeMarkdown(advisory.title)}`);
			if (advisory.severity) {
				markdown.appendMarkdown(` (${escapeMarkdown(advisory.severity)})`);
			}
			markdown.appendMarkdown('\n');
			if (advisory.treePath) {
				markdown.appendMarkdown('\nDependency tree:\n```text\n');
				markdown.appendText(advisory.treePath.trim());
				markdown.appendMarkdown('\n```\n');
			}
		}
	}

	markdown.appendMarkdown('\n#### Recent releases\n');
	if (versions.length === 0) {
		markdown.appendMarkdown('Release history unavailable.\n');
	} else {
		for (const version of versions.slice(0, 10)) {
			const labels = [
				version.number === latestVersion ? 'latest' : '',
				version.number === installedVersion ? 'installed' : '',
				version.yanked ? 'yanked' : '',
			].filter(Boolean);
			markdown.appendMarkdown(`- ${inlineCode(version.number)}${labels.length ? ` (${labels.join(', ')})` : ''}\n`);
		}
	}
	return markdown;
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