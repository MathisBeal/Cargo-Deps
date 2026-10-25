import * as vscode from 'vscode';
import { DependencyAnalysisService } from '../services/analysis';
import { documentHealth, isCargoManifest, versionEdit } from '../services/updates';

export class CargoCodeActionsProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	constructor(private readonly analysis: DependencyAnalysisService) {}

	async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> {
		if (!vscode.workspace.isTrusted || !isCargoManifest(document)) {
			return [];
		}
		const documentVersion = document.version;
		const health = await documentHealth(document, this.analysis);
		if (document.version !== documentVersion) {
			return [];
		}
		return health.flatMap(item => {
			const source = item.dependency.versionRange;
			if (!source || (item.dependency.line !== range.start.line
				&& document.positionAt(source.start).line !== range.start.line)) {
				return [];
			}
			const versions = [...new Set([item.latestVersion, ...item.versions.slice(0, 10).filter(version => !version.yanked).map(version => version.number)])];
			return versions.flatMap(version => {
				const edit = versionEdit(document, item, version);
				if (!edit) {
					return [];
				}
				const action = new vscode.CodeAction(`Set ${item.dependency.name} to ${version}${version === item.latestVersion ? ' (latest)' : ''}`, vscode.CodeActionKind.QuickFix);
				action.isPreferred = version === item.latestVersion;
				action.edit = new vscode.WorkspaceEdit();
				action.edit.set(document.uri, [edit]);
				return [action];
			});
		});
	}
}
