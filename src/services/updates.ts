import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from './analysis';
import { parseDependencies } from './manifest';
import type { DependencyHealth } from '../types';

export const SET_VERSION_COMMAND = 'cargo-deps.setVersion';

export interface VersionSelection {
	uri: string;
	documentVersion: number;
	line: number;
	name: string;
	version: string;
}

export function isCargoManifest(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && path.basename(document.uri.fsPath) === 'Cargo.toml';
}

export async function documentHealth(document: vscode.TextDocument, analysis: DependencyAnalysisService): Promise<DependencyHealth[]> {
	const snapshot = analysis.getSnapshot(path.dirname(document.uri.fsPath));
	if (!snapshot) {
		return [];
	}
	if (snapshot.contents === document.getText()) {
		return snapshot.dependencies;
	}
	const dependencies = await parseDependencies(document.getText());
	return dependencies.flatMap(dependency => {
		const previous = snapshot.dependencies.find(item => item.dependency.name === dependency.name && item.dependency.packageName === dependency.packageName);
		return previous ? [{ ...previous, dependency }] : [];
	});
}

export function versionEdit(document: vscode.TextDocument, health: DependencyHealth, version: string): vscode.TextEdit | undefined {
	const range = health.dependency.versionRange;
	if (!range || health.dependency.localPath || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
		|| health.versions.some(release => release.number === version && release.yanked)) {
		return undefined;
	}
	const current = document.getText().slice(range.start, range.end);
	// Keep simple Cargo operators; compound requirements are replaced as a whole.
	const operator = /^\s*([~^=])\s*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(current)?.[1] ?? '';
	const replacement = `${operator}${version}`;
	if (current === replacement) {
		return undefined;
	}
	return new vscode.TextEdit(new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), replacement);
}

export function selectionFor(document: vscode.TextDocument, health: DependencyHealth, version: string): VersionSelection {
	return { uri: document.uri.toString(), documentVersion: document.version, line: health.dependency.line, name: health.dependency.name, version };
}

export async function setVersion(analysis: DependencyAnalysisService, value: unknown): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		throw new Error('Trust this workspace to update Cargo dependencies.');
	}
	if (!value || typeof value !== 'object') {
		throw new Error('Invalid dependency version selection.');
	}
	const selection = value as Partial<VersionSelection>;
	if (typeof selection.uri !== 'string' || !Number.isInteger(selection.documentVersion) || !Number.isInteger(selection.line)
		|| typeof selection.name !== 'string' || typeof selection.version !== 'string') {
		throw new Error('Invalid dependency version selection.');
	}
	const uri = vscode.Uri.parse(selection.uri);
	if (uri.scheme !== 'file' || path.basename(uri.fsPath) !== 'Cargo.toml') {
		throw new Error('Dependency updates require a Cargo.toml file.');
	}
	const document = await vscode.workspace.openTextDocument(uri);
	const health = (await documentHealth(document, analysis)).find(item => item.dependency.line === selection.line && item.dependency.name === selection.name);
	if (document.version !== selection.documentVersion || !health) {
		throw new Error('The manifest has changed. Reopen the dependency hover and try again.');
	}
	if (selection.version !== health.latestVersion && !health.versions.some(release => release.number === selection.version && !release.yanked)) {
		throw new Error('This version is not available in the dependency analysis.');
	}
	const edit = versionEdit(document, health, selection.version);
	if (!edit) {
		throw new Error('This dependency version cannot be changed here, or is already selected.');
	}
	const workspaceEdit = new vscode.WorkspaceEdit();
	workspaceEdit.set(uri, [edit]);
	if (!await vscode.workspace.applyEdit(workspaceEdit)) {
		throw new Error('VS Code could not apply the dependency update.');
	}
}

export async function updateManifests(analysis: DependencyAnalysisService, uris: vscode.Uri[]): Promise<void> {
	const workspaceEdit = new vscode.WorkspaceEdit();
	const versions = new Map<vscode.TextDocument, number>();
	let count = 0;
	let unavailable = 0;
	for (const uri of uris) {
		const document = await vscode.workspace.openTextDocument(uri);
		if (!isCargoManifest(document)) {
			continue;
		}
		const documentVersion = document.version;
		const health = await documentHealth(document, analysis);
		const edits = health.flatMap(item => {
			if (!item.dependency.versionRange) {
				return [];
			}
			if (!item.latestVersion || item.versions.some(release => release.number === item.latestVersion && release.yanked)) {
				unavailable++;
				return [];
			}
			const edit = versionEdit(document, item, item.latestVersion);
			return edit ? [edit] : [];
		});
		const snapshot = analysis.getSnapshot(path.dirname(uri.fsPath));
		if (!snapshot || !snapshot.contents) {
			unavailable++;
		} else if (snapshot.contents !== document.getText()) {
			const current = await parseDependencies(document.getText());
			unavailable += current.filter(dependency => dependency.versionRange && !health.some(item =>
				item.dependency.versionRange?.start === dependency.versionRange?.start)).length;
		}
		versions.set(document, documentVersion);
		if (edits.length) {
			workspaceEdit.set(uri, edits);
			count += edits.length;
		}
	}
	if ([...versions].some(([document, version]) => document.version !== version)) {
		throw new Error('A manifest changed while preparing updates. Please try again.');
	}
	if (count && !await vscode.workspace.applyEdit(workspaceEdit)) {
		throw new Error('VS Code could not apply the dependency updates.');
	}
	const message = count
		? `Updated ${count} dependency requirement(s). Review and save the manifests to refresh analysis.`
		: 'No dependency requirements need updating.';
	if (unavailable) {
		void vscode.window.showWarningMessage(`${message} Analysis or latest version unavailable for ${unavailable} item(s); see Cargo Deps output.`);
	} else {
		void vscode.window.showInformationMessage(message);
	}
}
