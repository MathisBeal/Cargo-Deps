import * as vscode from 'vscode';
import * as path from 'node:path';
import { DependencyAnalysisService } from './analysis';
import { isCratesIoDependency, parseDependencies } from './manifest';
import type { AnalysisSnapshot, DependencyHealth } from '../types';
import { isOutdated } from '../providers/hintsProvider';

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
	const dependencies = await parseDependencies(document.getText(), snapshot.workspaceDependencies);
	return dependencies.flatMap(dependency => {
		const previous = snapshot.dependencies.find(item => item.dependency.name === dependency.name && item.dependency.packageName === dependency.packageName);
		return previous ? [{ ...previous, dependency }] : [];
	});
}

export function versionEdit(document: vscode.TextDocument, health: DependencyHealth, version: string): vscode.TextEdit | undefined {
	const range = health.dependency.versionRange;
	if (!range) {
		return undefined;
	}
	const replacement = versionReplacement(health, version, document.getText().slice(range.start, range.end));
	return replacement === undefined ? undefined
		: new vscode.TextEdit(new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), replacement);
}

function versionReplacement(health: DependencyHealth, version: string, current: string): string | undefined {
	if (health.dependency.localPath || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
		|| health.versions.some(release => release.number === version && release.yanked)) {
		return undefined;
	}
	// Keep simple Cargo operators; compound requirements are replaced as a whole.
	const operator = /^\s*([~^=])\s*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(current)?.[1] ?? '';
	const replacement = `${operator}${version}`;
	return current === replacement ? undefined : replacement;
}

export function canUpdateToLatest(health: DependencyHealth): boolean {
	return isCratesIoDependency(health.dependency)
		&& isOutdated(health.installedVersion, health.latestVersion)
		&& versionReplacement(health, health.latestVersion, health.dependency.versionRequirement) !== undefined;
}

export interface DependencyUpdateRequest {
	snapshot: AnalysisSnapshot;
	health: DependencyHealth;
}

export interface DependencyUpdatePlan {
	edit: vscode.WorkspaceEdit;
	documents: { snapshot: AnalysisSnapshot; document: vscode.TextDocument; version: number }[];
	count: number;
}

export function dependencyUpdateTarget(analysis: DependencyAnalysisService, request: DependencyUpdateRequest): DependencyUpdateRequest {
	const { snapshot, health } = request;
	if (analysis.getSnapshot(snapshot.root) !== snapshot || !snapshot.dependencies.includes(health)) {
		throw new Error('Dependency analysis changed. Select the dependency again.');
	}
	if (health.dependency.workspace !== 'inherited') {
		return request;
	}
	const workspace = snapshot.workspaceRoot ? analysis.getSnapshot(snapshot.workspaceRoot) : undefined;
	const declaration = workspace?.dependencies.find(item => item.dependency.workspace === 'declaration'
		&& item.dependency.name === health.dependency.name && item.dependency.packageName === health.dependency.packageName);
	if (!workspace || !declaration || declaration.dependency.versionRequirement !== health.dependency.versionRequirement) {
		throw new Error(`Workspace declaration for ${health.dependency.name} is unavailable or changed. Refresh the analysis first.`);
	}
	return { snapshot: workspace, health: declaration };
}

export async function prepareDependencyUpdates(analysis: DependencyAnalysisService, requests: readonly DependencyUpdateRequest[]): Promise<DependencyUpdatePlan> {
	if (!vscode.workspace.isTrusted) {
		throw new Error('Trust this workspace to update Cargo dependencies.');
	}
	const documents = new Map<string, DependencyUpdatePlan['documents'][number]>();
	const edits = new Map<string, Map<number, vscode.TextEdit>>();
	const readDocument = async (snapshot: AnalysisSnapshot) => {
		let entry = documents.get(snapshot.root);
		if (!entry) {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(snapshot.root, 'Cargo.toml')));
			entry = { snapshot, document, version: document.version };
			documents.set(snapshot.root, entry);
		}
		if (entry.snapshot !== snapshot || analysis.getSnapshot(snapshot.root) !== snapshot
			|| entry.document.getText() !== snapshot.contents) {
			throw new Error(`Save ${path.join(snapshot.root, 'Cargo.toml')} and refresh its analysis before updating from the panel.`);
		}
		return entry.document;
	};
	for (const request of requests) {
		const target = dependencyUpdateTarget(analysis, request);
		if (!canUpdateToLatest(request.health)) {
			throw new Error(`No available latest-version update for ${request.health.dependency.name}.`);
		}
		await readDocument(request.snapshot);
		const document = await readDocument(target.snapshot);
		const version = request.health.latestVersion;
		if (target.health.latestVersion !== version && !target.health.versions.some(release => release.number === version && !release.yanked)) {
			throw new Error(`Version ${version} is unavailable for ${target.health.dependency.name} in its declaration.`);
		}
		const edit = versionEdit(document, target.health, version);
		const start = target.health.dependency.versionRange?.start;
		if (!edit || start === undefined) {
			throw new Error(`The declaration for ${target.health.dependency.name} cannot be updated here.`);
		}
		const documentEdits = edits.get(target.snapshot.root) ?? new Map<number, vscode.TextEdit>();
		const previous = documentEdits.get(start);
		if (previous && previous.newText !== edit.newText) {
			throw new Error(`Conflicting updates for the shared declaration of ${target.health.dependency.name}.`);
		}
		documentEdits.set(start, edit);
		edits.set(target.snapshot.root, documentEdits);
	}
	const edit = new vscode.WorkspaceEdit();
	let count = 0;
	for (const [root, changes] of edits) {
		edit.set(documents.get(root)!.document.uri, [...changes.values()]);
		count += changes.size;
	}
	const plan = { edit, documents: [...documents.values()], count };
	validateDependencyUpdatePlan(analysis, plan);
	return plan;
}

function validateDependencyUpdatePlan(analysis: DependencyAnalysisService, plan: DependencyUpdatePlan): void {
	for (const { snapshot, document, version } of plan.documents) {
		if (analysis.getSnapshot(snapshot.root) !== snapshot || document.version !== version) {
			throw new Error('A manifest or its analysis changed while preparing updates. Select the updates again.');
		}
	}
}

export async function applyDependencyUpdates(analysis: DependencyAnalysisService, plan: DependencyUpdatePlan): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		throw new Error('Trust this workspace to update Cargo dependencies.');
	}
	validateDependencyUpdatePlan(analysis, plan);
	if (!plan.count || !await vscode.workspace.applyEdit(plan.edit)) {
		throw new Error('VS Code could not apply the dependency updates.');
	}
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
