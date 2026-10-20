import * as vscode from 'vscode';
import type { AnalysisSnapshot, Dependency } from '../types';
import { isOutdated } from './hintsProvider';

export function buildDiagnostics(snapshot: AnalysisSnapshot): vscode.Diagnostic[] {
	const lines = snapshot.contents.split(/\r?\n/);
	return snapshot.dependencies.flatMap(health => {
		const { dependency } = health;
		const text = lines[dependency.line];
		if (text === undefined) {
			return [];
		}
		const range = dependencyRange(dependency, text);
		const diagnostics: vscode.Diagnostic[] = [];
		if (!dependency.localPath && isOutdated(health.installedVersion, health.latestVersion)) {
			const diagnostic = new vscode.Diagnostic(
				range,
				`${dependency.name}: update available (${health.installedVersion} -> ${health.latestVersion}).`,
				vscode.DiagnosticSeverity.Information,
			);
			diagnostic.source = 'cargo-deps';
			diagnostic.code = 'outdated';
			diagnostics.push(diagnostic);
		}
		for (const advisory of health.advisories) {
			const transitive = advisory.packageName !== dependency.packageName;
			const diagnostic = new vscode.Diagnostic(
				range,
				`${dependency.name}${transitive ? ` -> ${advisory.packageName} ${advisory.packageVersion}` : ''}: ${advisory.title}${advisory.severity ? ` (${advisory.severity})` : ''} [${advisory.id}]`,
				vscode.DiagnosticSeverity.Warning,
			);
			diagnostic.source = 'cargo-deps';
			diagnostic.code = advisory.id;
			diagnostics.push(diagnostic);
		}
		return diagnostics;
	});
}

function dependencyRange(dependency: Dependency, text: string): vscode.Range {
	const version = /\bversion\s*=\s*(["'])([^"']*)\1/.exec(text)
		?? /=\s*(["'])([^"']*)\1/.exec(text);
	if (version) {
		const start = version.index + version[0].indexOf(version[1]) + 1;
		return new vscode.Range(dependency.line, start, dependency.line, start + version[2].length);
	}
	const inherited = /\bworkspace\s*=\s*(true)\b/.exec(text);
	if (inherited) {
		const start = inherited.index + inherited[0].lastIndexOf('true');
		return new vscode.Range(dependency.line, start, dependency.line, start + 4);
	}
	const start = Math.max(0, text.indexOf(dependency.name));
	return new vscode.Range(dependency.line, start, dependency.line, Math.min(text.length, start + dependency.name.length));
}