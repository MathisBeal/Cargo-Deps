import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from '../services/analysis';

export class CargoHintsProvider implements vscode.InlayHintsProvider {
	constructor(private readonly analysis: DependencyAnalysisService) {}

	get onDidChangeInlayHints() {
		return this.analysis.onDidChange;
	}

	provideInlayHints(
		document: vscode.TextDocument,
		range: vscode.Range,
	): vscode.InlayHint[] {
		if (path.basename(document.uri.fsPath) !== 'Cargo.toml') {
			return [];
		}

		const root = path.dirname(document.uri.fsPath);
		const snapshot = this.analysis.getSnapshot(root);
		if (!snapshot) {
			return [];
		}

		return snapshot.dependencies.flatMap(health => {
			const line = health.dependency.line;
			if (!range.contains(new vscode.Position(line, 0))) {
				return [];
			}

			const labels: string[] = [];
			if (isOutdated(health.installedVersion, health.latestVersion)) {
				labels.push(`❌ ${health.installedVersion} -> ${health.latestVersion}`);
			}
			if (health.advisories.length > 0) {
				labels.push('⚠️ Vulnérabilité détectée');
			}
			if (labels.length === 0) {
				return [];
			}

			const lineText = document.lineAt(line).text;
			const hint = new vscode.InlayHint(new vscode.Position(line, lineText.length), ` ${labels.join(' | ')}`, vscode.InlayHintKind.Type);
			hint.paddingLeft = true;
			hint.tooltip = health.advisories.length > 0
				? `Security advisories: ${health.advisories.map(advisory => advisory.id).join(', ')}`
				: `Latest version: ${health.latestVersion}`;
			return [hint];
		});
	}
}

export function isOutdated(installed: string, latest: string): boolean {
	return Boolean(installed && latest && normalizeVersion(installed) !== normalizeVersion(latest));
}

function normalizeVersion(version: string): string {
	return version.trim().replace(/^[v=\s]+/, '');
}