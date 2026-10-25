import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseDependencies } from '../services/manifest';
import { DependencyAnalysisService } from '../services/analysis';
import { documentHealth, selectionFor, setVersion, updateManifests, versionEdit, SET_VERSION_COMMAND } from '../services/updates';
import { CargoCodeActionsProvider } from '../providers/codeActionsProvider';
import { CargoHoverProvider } from '../providers/hoverProvider';
import type { AnalysisSnapshot, DependencyHealth } from '../types';

function healthFor(dependency: DependencyHealth['dependency']): DependencyHealth {
	return {
		dependency, installedVersion: '1.0.0', latestVersion: '2.0.0', advisories: [],
		versions: [
			{ number: '2.0.0', createdAt: '', yanked: false },
			{ number: '1.5.0', createdAt: '', yanked: false },
			{ number: '1.4.0', createdAt: '', yanked: true },
		],
	};
}

class TestAnalysis extends DependencyAnalysisService {
	readonly snapshotsForTest = new Map<string, AnalysisSnapshot>();
	override getSnapshot(root: string) { return this.snapshotsForTest.get(root); }
}

suite('Dependency version updates', () => {
	const roots: string[] = [];
	const analysis = new TestAnalysis();
	async function manifest(contents: string) {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-update-'));
		roots.push(root);
		const uri = vscode.Uri.file(path.join(root, 'Cargo.toml'));
		await writeFile(uri.fsPath, contents);
		const dependencies = (await parseDependencies(contents)).map(healthFor);
		analysis.snapshotsForTest.set(root, { root, contents, dependencies, updatedAt: 0 });
		return { uri, document: await vscode.workspace.openTextDocument(uri), dependencies };
	}
	suiteTeardown(async () => {
		analysis.dispose();
		for (const root of roots) {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('locates only version strings across TOML forms, preserving comments and options', async () => {
		const contents = [
			'[package]',
			'name = "demo"',
			'version = "9.0.0"',
			'description = """',
			'[dependencies]',
			'fake = "9.0.0"',
			'"""',
			'[dependencies] # comment',
			'serde = "^1.0" # version = "do not touch"',
			'"fast.hash" = { package = "hashbrown", features = ["version", "1.0"], version = \'~1.0\' }',
			'quoted."version" = "=1.0"',
			'compound = ">=1, <2"',
			'[dependencies.table] # comment',
			'features = ["version = 1.0"]',
			'"version" = "1.0"',
			'[target.\'cfg(target_os = "linux")\'.dependencies]',
			'serde = "1.0"',
			'[workspace.dependencies]',
			'root = "1.0"',
		].join('\r\n');
		const { document, dependencies } = await manifest(contents);
		const edits = dependencies.flatMap(health => {
			const edit = versionEdit(document, health, '2.0.0');
			return edit ? [edit] : [];
		});
		assert.equal(edits.length, 7);
		const changes = new vscode.WorkspaceEdit();
		changes.set(document.uri, edits);
		assert.equal(await vscode.workspace.applyEdit(changes), true);
		assert.equal(document.getText(), contents
			.replace('serde = "^1.0"', 'serde = "^2.0.0"')
			.replace("version = '~1.0'", "version = '~2.0.0'")
			.replace('"version" = "=1.0"', '"version" = "=2.0.0"')
			.replace('compound = ">=1, <2"', 'compound = "2.0.0"')
			.replace('"version" = "1.0"', '"version" = "2.0.0"')
			.replace('serde = "1.0"', 'serde = "2.0.0"')
			.replace('root = "1.0"', 'root = "2.0.0"'));
		await parseDependencies(document.getText());
	});

	test('does not edit inherited, path, Git or alternate-registry dependencies', async () => {
		const { document, dependencies } = await manifest([
			'[dependencies]',
			'local = { path = "../local", version = "1.0" }',
			'git = { git = "https://example.invalid/repo", version = "1.0" }',
			'private = { registry = "private", version = "1.0" }',
			'inherited.workspace = true',
			'[dependencies.inheritedTable]',
			'workspace = true',
		].join('\n'));
		assert.equal(dependencies.length, 5);
		assert.ok(dependencies.every(health => !versionEdit(document, health, '2.0.0')));
	});

	test('offers latest and previous releases as quick fixes but never yanked versions', async () => {
		const { document } = await manifest('[dependencies]\nserde = { version = "1.0", features = ["derive"] }');
		const actions = await new CargoCodeActionsProvider(analysis).provideCodeActions(document, new vscode.Range(1, 0, 1, 1));
		assert.equal(actions.length, 2);
		assert.equal(actions[0].isPreferred, true);
		assert.ok(actions[1].title.includes('1.5.0'));
		assert.equal(await vscode.workspace.applyEdit(actions[1].edit!), true);
		assert.ok(document.getText().includes('version = "1.5.0", features = ["derive"]'));
		const newActions = await new CargoCodeActionsProvider(analysis).provideCodeActions(document, new vscode.Range(1, 0, 1, 1));
		assert.equal(newActions.length, 1);
		assert.ok(newActions[0].title.includes('2.0.0'));
	});

	test('hover links select the requested release, reject stale selections and permit only the update command', async () => {
		const { document } = await manifest('[dependencies]\nserde = "1.0"');
		const hover = await new CargoHoverProvider(analysis).provideHover(document, new vscode.Position(1, 0));
		assert.ok(hover);
		const markdown = hover.contents[0] as vscode.MarkdownString;
		assert.deepEqual(markdown.isTrusted, { enabledCommands: [SET_VERSION_COMMAND] });
		const links = [...markdown.value.matchAll(/command:cargo-deps\.setVersion\?([^ )]+)/g)];
		assert.ok(links.length >= 2);
		const selections = links.map(link => JSON.parse(decodeURIComponent(link[1]))[0]);
		assert.ok(!selections.some(selection => selection.version === '1.4.0'));
		const previous = selections.find(selection => selection.version === '1.5.0');
		await setVersion(analysis, previous);
		assert.equal(document.getText(), '[dependencies]\nserde = "1.5.0"');
		assert.equal(document.isDirty, true);
		await assert.rejects(setVersion(analysis, previous), /manifest has changed/);
		const health = (await documentHealth(document, analysis))[0];
		await assert.rejects(setVersion(analysis, selectionFor(document, health, '1.4.0')), /not available/);
		await assert.rejects(setVersion(analysis, { uri: document.uri.toString(), version: '2.0.0' }), /Invalid/);
		await setVersion(analysis, selectionFor(document, health, '2.0.0'));
		assert.equal(document.getText(), '[dependencies]\nserde = "2.0.0"');
	});

	test('bulk updates only selected manifests and can include closed workspace manifests', async () => {
		const first = await manifest('[dependencies]\nserde = "1.0"');
		const second = await manifest('[workspace.dependencies]\nserde = { version = "=1.0", features = ["derive"] }');
		const thirdRoot = await mkdtemp(path.join(tmpdir(), 'cargo-deps-update-'));
		roots.push(thirdRoot);
		const thirdUri = vscode.Uri.file(path.join(thirdRoot, 'Cargo.toml'));
		const thirdContents = '[dev-dependencies]\nserde = "1.0"';
		await writeFile(thirdUri.fsPath, thirdContents);
		analysis.snapshotsForTest.set(thirdRoot, {
			root: thirdRoot, contents: thirdContents, updatedAt: 0,
			dependencies: (await parseDependencies(thirdContents)).map(healthFor),
		});
		assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === thirdUri.toString()));
		await updateManifests(analysis, [first.uri]);
		assert.equal(first.document.getText(), '[dependencies]\nserde = "2.0.0"');
		assert.ok(!second.document.isDirty);
		await updateManifests(analysis, [first.uri, second.uri, thirdUri]);
		assert.equal(second.document.getText(), '[workspace.dependencies]\nserde = { version = "=2.0.0", features = ["derive"] }');
		assert.equal((await vscode.workspace.openTextDocument(thirdUri)).getText(), '[dev-dependencies]\nserde = "2.0.0"');
	});

	test('does not offer edits for current, yanked or invalid versions', async () => {
		const { document, dependencies } = await manifest('[dependencies]\nserde = "2.0.0"');
		for (const version of ['2.0.0', '1.4.0', '', '2.0.0" # injected']) {
			assert.equal(versionEdit(document, dependencies[0], version), undefined);
		}
	});

	test('handles quoted multiline text ending in four or five quotes without finding fake dependencies', async () => {
		for (const quote of ['"', "'"]) {
			for (const count of [4, 5]) {
				const contents = `[package]\ndescription = ${quote.repeat(3)}\n[dependencies]\nfake = ${quote}9.0${quote}\ntext${quote.repeat(count)}\n[dependencies]\nreal = "1.0"`;
				const { document, dependencies } = await manifest(contents);
				assert.equal(dependencies.length, 1);
				assert.equal(dependencies[0].dependency.name, 'real');
				assert.ok(versionEdit(document, dependencies[0], '2.0.0'));
			}
		}
	});

	test('contributes both bulk update commands to the F1 command palette', async () => {
		const extension = vscode.extensions.getExtension('MathisBEAL.cargo-deps');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['cargo-deps.updateOpen', 'cargo-deps.updateAll']) {
			assert.ok(commands.includes(command));
			assert.ok(extension.packageJSON.contributes.commands.some((item: { command: string }) => item.command === command));
		}
		assert.ok(commands.includes(SET_VERSION_COMMAND));
	});
});
