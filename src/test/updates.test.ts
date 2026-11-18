import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseDependencies, parseManifest } from '../services/manifest';
import { DependencyAnalysisService } from '../services/analysis';
import {
	applyDependencyUpdates, documentHealth, prepareDependencyUpdates, selectionFor, setVersion,
	updateManifests, versionEdit, SET_VERSION_COMMAND,
} from '../services/updates';
import { CargoCodeActionsProvider } from '../providers/codeActionsProvider';
import { CargoHoverProvider } from '../providers/hoverProvider';
import { CargoHintsProvider } from '../providers/hintsProvider';
import { DependencyTreeProvider } from '../providers/dependencyTree';
import type { AnalysisSnapshot, Dependency, DependencyHealth } from '../types';

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
	private readonly snapshotsForTest = new Map<string, AnalysisSnapshot>();
	override getSnapshot(root: string) { return this.snapshotsForTest.get(root); }
	override getSnapshots() { return [...this.snapshotsForTest.values()]; }
	override forget(root: string) {
		this.snapshotsForTest.delete(root);
		super.forget(root);
	}

	async addManifest(root: string, contents: string, workspaceDependencies: Dependency[] = []) {
		// Match the URI-derived roots used by the providers, including Windows drive casing.
		root = vscode.Uri.file(root).fsPath;
		const manifest = await parseManifest(contents, workspaceDependencies);
		const dependencies = manifest.dependencies.map(healthFor);
		this.snapshotsForTest.set(root, { root, contents, packageName: manifest.packageName, dependencies, workspaceDependencies, updatedAt: 0 });
		return dependencies;
	}
}

suite('Dependency version updates', () => {
	const roots: string[] = [];
	const analysis = new TestAnalysis();
	async function manifest(contents: string, workspaceDependencies: Dependency[] = [], owner = analysis) {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-update-'));
		roots.push(root);
		const uri = vscode.Uri.file(path.join(root, 'Cargo.toml'));
		await writeFile(uri.fsPath, contents);
		const dependencies = await owner.addManifest(root, contents, workspaceDependencies);
		return { uri, document: await vscode.workspace.openTextDocument(uri), dependencies, snapshot: owner.getSnapshot(path.dirname(uri.fsPath))! };
	}
	suiteTeardown(async () => {
		assert.equal(vscode.extensions.getExtension('MathisBEAL.cargo-deps')?.isActive, false,
			'Provider tests must not activate real Cargo scans over their temporary manifests');
		analysis.dispose();
		for (const root of roots) {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('finds snapshots by URI-normalized roots, including uppercase Windows drive letters', async () => {
		const root = 'C:/Users/runner/AppData/Local/Temp/cargo-deps-path-test';
		const uri = vscode.Uri.file(`${root}/Cargo.toml`);
		const contents = '[dependencies]\nserde = "1.0"';
		const dependencies = await analysis.addManifest(root, contents);
		const snapshot = analysis.getSnapshot(path.dirname(uri.fsPath));
		assert.ok(snapshot, `Snapshot missing for URI path ${uri.fsPath} (native root: ${root})`);
		assert.equal(snapshot.root, path.dirname(uri.fsPath));
		assert.strictEqual(snapshot.dependencies, dependencies);
	});

	for (const eol of ['\n', '\r\n']) {
		test(`shares snapshot lookup across quick fixes, hovers and bulk updates with ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
			const contents = ['[dependencies]', 'serde = "1.0"'].join(eol);
			const { document, dependencies } = await manifest(contents);
			assert.equal(document.getText(), contents);
			assert.strictEqual(await documentHealth(document, analysis), dependencies);
			assert.equal(dependencies[0].dependency.line, 1);
			const actions = await new CargoCodeActionsProvider(analysis).provideCodeActions(document, new vscode.Range(1, 0, 1, 1));
			assert.equal(actions.length, 2);
			assert.ok(await new CargoHoverProvider(analysis).provideHover(document, new vscode.Position(1, 0)));
			await updateManifests(analysis, [document.uri]);
			assert.equal(document.getText(), ['[dependencies]', 'serde = "2.0.0"'].join(eol));
		});
	}

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

	test('hides stale hints after unsaved edits instead of using outdated line numbers', async () => {
		const { document } = await manifest('[dependencies]\n\n\nserde = "1.0"');
		const hints = new CargoHintsProvider(analysis);
		assert.equal(hints.provideInlayHints(document, new vscode.Range(0, 0, 4, 0)).length, 1);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(0, 0, 4, 0), '');
		assert.equal(await vscode.workspace.applyEdit(edit), true);
		assert.deepEqual(hints.provideInlayHints(document, new vscode.Range(0, 0, 1, 0)), []);
	});

	test('distinguishes unavailable audits and non-crates.io sources in dependency hovers', async () => {
		const { document, dependencies } = await manifest([
			'[dependencies]',
			'serde = "1.0"',
			'git = { git = "https://example.invalid/repo", version = "1.0" }',
			'private = { registry = "company", version = "1.0" }',
		].join('\n'));
		dependencies[0].auditAvailable = false;
		const provider = new CargoHoverProvider(analysis);
		const hover = await provider.provideHover(document, new vscode.Position(1, 0));
		assert.ok(hover);
		const markdown = hover.contents[0] as vscode.MarkdownString;
		assert.ok(markdown.value.includes('Security analysis unavailable'));
		assert.ok(!markdown.value.includes('No known vulnerabilities'));
		for (const line of [2, 3]) {
			const sourceHover = await provider.provideHover(document, new vscode.Position(line, 0));
			assert.ok(sourceHover);
			const contents = (sourceHover.contents[0] as vscode.MarkdownString).value;
			assert.ok(contents.includes('Not checked on crates.io'));
			assert.ok(contents.includes('Release history is not checked'));
			assert.ok(!contents.includes(`command:${SET_VERSION_COMMAND}`));
		}
	});

	test('offers compact source-aware resource links using package names and preserves them after unsaved edits', async () => {
		const { document, dependencies } = await manifest([
			'[dependencies]',
			'transport = { package = "serde", version = "1.0" }',
			'plain = "1.0"',
			'gitdep = { git = "https://example.invalid/project.git" }',
			'sshdep = { git = "ssh://git@example.invalid/project.git" }',
			'local = { path = "../local" }',
			'private = { registry = "company", version = "1.0" }',
		].join('\n'));
		dependencies[0].documentationUrl = 'https://docs.rs/serde/latest/serde/';
		dependencies[0].repositoryUrl = 'https://github.com/serde-rs/serde';
		for (const dependency of dependencies.slice(2)) {
			dependency.documentationUrl = 'https://wrong-source.invalid/docs';
			dependency.repositoryUrl = 'https://wrong-source.invalid/repo';
		}
		const provider = new CargoHoverProvider(analysis);
		const linksAt = async (line: number) => {
			const hover = await provider.provideHover(document, new vscode.Position(line, 0));
			assert.ok(hover);
			return [...(hover.contents[0] as vscode.MarkdownString).value.matchAll(/\[(Documentation|Repository|crates\.io)\]\(<([^<>]+)>\)/g)]
				.map(([, label, url]) => [label, url]);
		};
		const resources = [
			['Documentation', 'https://docs.rs/serde/latest/serde/'],
			['Repository', 'https://github.com/serde-rs/serde'],
			['crates.io', 'https://crates.io/crates/serde'],
		];
		assert.deepEqual(await linksAt(1), resources);
		assert.deepEqual(await linksAt(2), [['crates.io', 'https://crates.io/crates/plain']]);
		assert.deepEqual(await linksAt(3), [['Repository', 'https://example.invalid/project.git']]);
		for (const line of [4, 5, 6]) {
			assert.deepEqual(await linksAt(line), []);
		}
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '# Unsaved comment\n');
		assert.equal(await vscode.workspace.applyEdit(edit), true);
		assert.deepEqual(await linksAt(2), resources);
	});

	test('rejects unsafe resource URLs and keeps Markdown delimiters inside the external link target', async () => {
		const { document, dependencies } = await manifest('[dependencies]\nserde = "1.0"');
		const provider = new CargoHoverProvider(analysis);
		const markdownFor = async (url: string) => {
			dependencies[0].documentationUrl = url;
			dependencies[0].repositoryUrl = url;
			const hover = await provider.provideHover(document, new vscode.Position(1, 0));
			assert.ok(hover);
			return hover.contents[0] as vscode.MarkdownString;
		};
		for (const url of [
			'not a URL',
			'//example.invalid/docs',
			'command:cargo-deps.setVersion',
			'javascript:alert(1)',
			'data:text/html,test',
			'file:///tmp/docs',
			'ssh://git@example.invalid/repo',
			'https://user:password@example.invalid/docs',
		]) {
			const markdown = await markdownFor(url);
			assert.ok(!markdown.value.includes('[Documentation]'));
			assert.ok(!markdown.value.includes('[Repository]'));
			assert.ok(!markdown.value.includes(`(<${url}>)`));
			assert.ok(markdown.value.includes('[crates.io](<https://crates.io/crates/serde>)'));
			assert.deepEqual(markdown.isTrusted, { enabledCommands: [SET_VERSION_COMMAND] });
		}
		const markdown = await markdownFor('https://example.invalid/docs(v1)> [Injected](command:unexpected)');
		const resources = [...markdown.value.matchAll(/\[(Documentation|Repository)\]\(<([^<>]+)>\)/g)];
		assert.equal(resources.length, 2);
		assert.ok(resources.every(([, , target]) => target === 'https://example.invalid/docs(v1)%3E%20[Injected](command:unexpected)'));
		assert.ok(!markdown.value.includes('> [Injected]'));
		assert.deepEqual(markdown.isTrusted, { enabledCommands: [SET_VERSION_COMMAND] });
	});

	test('preserves inherited aliases and sources when providing hovers for unsaved manifests', async () => {
		const workspaceDependencies = await parseDependencies([
			'[workspace.dependencies]',
			'transport = { package = "network", git = "https://example.invalid/repo", version = "1.0" }',
		].join('\n'));
		const { document } = await manifest('[dependencies.transport]\nworkspace = true', workspaceDependencies);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '# Unsaved comment\n');
		assert.equal(await vscode.workspace.applyEdit(edit), true);
		const health = await documentHealth(document, analysis);
		assert.equal(health[0].dependency.packageName, 'network');
		assert.equal(health[0].dependency.git, 'https://example.invalid/repo');
		const hover = await new CargoHoverProvider(analysis).provideHover(document, new vscode.Position(health[0].dependency.line, 0));
		assert.ok(hover);
		assert.ok((hover.contents[0] as vscode.MarkdownString).value.includes('Not checked on crates.io'));
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
		await analysis.addManifest(thirdRoot, thirdContents);
		assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === thirdUri.toString()));
		await updateManifests(analysis, [first.uri]);
		assert.equal(first.document.getText(), '[dependencies]\nserde = "2.0.0"');
		assert.ok(!second.document.isDirty);
		await updateManifests(analysis, [first.uri, second.uri, thirdUri]);
		assert.equal(second.document.getText(), '[workspace.dependencies]\nserde = { version = "=2.0.0", features = ["derive"] }');
		assert.equal((await vscode.workspace.openTextDocument(thirdUri)).getText(), '[dev-dependencies]\nserde = "2.0.0"');
	});

	test('groups the panel by real crate names, distinguishes sections and filters available updates', async () => {
		const model = new TestAnalysis();
		const dependencies = new DependencyTreeProvider('dependencies', model);
		const updates = new DependencyTreeProvider('updates', model);
		try {
			const app = await manifest([
				'[package]', 'name = "api"', 'version = "0.1.0"',
				'[dependencies]', 'serde = "1.0"', 'current = "2.0.0"',
				'local = { path = "../local", version = "1.0" }',
				'git = { git = "https://example.invalid/repo", version = "1.0" }',
				'private = { registry = "company", version = "1.0" }', 'retired = "1.0"',
				'[dev-dependencies]', 'serde = "1.0"',
			].join('\n'), [], model);
			app.dependencies.find(health => health.dependency.name === 'retired')!.latestVersion = '1.4.0';
			const worker = await manifest('[package]\nname = "worker"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"', [], model);
			await manifest('[package]\nname = "empty"\nversion = "0.1.0"', [], model);
			const groups = dependencies.getChildren();
			assert.deepEqual(groups.map(group => dependencies.getTreeItem(group).label), ['api', 'empty', 'worker']);
			assert.equal(dependencies.getTreeItem(groups[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			const rows = dependencies.getChildren(groups[0]);
			const serde = rows.filter(node => node.kind === 'dependency' && node.health.dependency.name === 'serde');
			assert.equal(serde.length, 2);
			assert.notEqual(dependencies.getTreeItem(serde[0]).id, dependencies.getTreeItem(serde[1]).id);
			assert.ok(serde.some(node => String(dependencies.getTreeItem(node).description).includes('dev')));
			assert.equal(updates.getUpdateRequests().length, 3);
			assert.ok(updates.getUpdateRequests().every(request => request.health.dependency.packageName === 'serde'));
			updates.setFilter(worker.snapshot.root);
			assert.equal(updates.getChildren().length, 1);
			assert.equal(updates.getUpdateRequests().length, 1);
			assert.equal(updates.getChildren()[0].snapshot.packageName, 'worker');
			model.forget(worker.snapshot.root);
			assert.equal(updates.filterRoot, undefined);
			assert.equal(updates.getChildren().length, 1);
		} finally {
			dependencies.dispose();
			updates.dispose();
			model.dispose();
		}
	});

	test('deduplicates transitive security alerts per crate without hiding affected routes or audit failures', async () => {
		const model = new TestAnalysis();
		const security = new DependencyTreeProvider('security', model);
		try {
			const app = await manifest('[dependencies]\nfirst = "1.0"\nsecond = "1.0"', [], model);
			const advisory = { id: 'RUSTSEC-TEST-1', title: 'A serious issue', packageName: 'affected', packageVersion: '1.0.0', severity: 'high' };
			app.dependencies[0].advisories = [
				{ ...advisory, treePath: '0affected v1.0.0\n1first v1.0.0' },
				{ ...advisory, id: 'Unknown advisory', title: 'Withdrawn release', severity: 'yanked' },
				{ ...advisory, id: 'Unknown advisory', title: 'Maintenance warning', severity: 'unmaintained' },
			];
			app.dependencies[1].advisories = [
				{ ...advisory, treePath: '0affected v1.0.0\n1second v1.0.0' },
				{ ...advisory, packageVersion: '0.5.0' },
			];
			app.snapshot.auditAvailable = false;
			await manifest('[dependencies]\nclean = "1.0"', [], model);
			const groups = security.getChildren();
			assert.equal(groups.length, 1);
			assert.ok(String(security.getTreeItem(groups[0]).description).includes('audit unavailable'));
			const nodes = security.getChildren(groups[0]);
			assert.equal(nodes.length, 5);
			assert.equal(new Set(nodes.map(node => security.getTreeItem(node).id)).size, 5);
			assert.equal(nodes[0].kind, 'message');
			assert.equal(security.getTreeItem(nodes[0]).command?.command, 'cargo-deps.showOutput');
			const shared = nodes.find(node => node.kind === 'advisory' && node.advisory.id === advisory.id && node.advisory.packageVersion === '1.0.0');
			assert.ok(shared?.kind === 'advisory');
			assert.equal(shared.via.length, 2);
			const item = security.getTreeItem(shared);
			assert.equal(item.label, 'RUSTSEC-TEST-1');
			assert.ok(!String(item.description).includes(advisory.title));
			assert.ok(item.tooltip instanceof vscode.MarkdownString);
			assert.ok(item.tooltip.value.replaceAll('&nbsp;', ' ').includes(advisory.title));
			assert.ok(item.tooltip.value.includes('first'));
			assert.ok(item.tooltip.value.includes('second'));
			assert.ok(item.tooltip.value.includes('affected v1.0.0'));
			assert.equal(item.tooltip.isTrusted, undefined);
			assert.equal(item.command?.command, 'vscode.open');
		} finally {
			security.dispose();
			model.dispose();
		}
	});

	test('resolves panel hovers lazily using the editor hover and rejects dirty or stale panel updates', async () => {
		const model = new TestAnalysis();
		const tree = new DependencyTreeProvider('dependencies', model);
		const token = new vscode.CancellationTokenSource();
		try {
			const source = await manifest('[dependencies]\nserde = "1.0"', [], model);
			source.dependencies[0].documentationUrl = 'https://docs.rs/serde/';
			const node = tree.getChildren(tree.getChildren()[0])[0];
			assert.ok(node.kind === 'dependency');
			const item = tree.getTreeItem(node);
			assert.equal(item.tooltip, undefined);
			const resolved = await tree.resolveTreeItem(item, node, token.token);
			const hover = await new CargoHoverProvider(model).provideHover(source.document, new vscode.Position(1, 0));
			assert.ok(hover && resolved.tooltip instanceof vscode.MarkdownString);
			assert.equal(resolved.tooltip.value, (hover.contents[0] as vscode.MarkdownString).value);
			let changes = 0;
			const subscription = tree.onDidChangeTreeData(() => { changes++; });
			try {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(source.uri, new vscode.Position(0, 0), '# Unsaved\n');
				assert.equal(await vscode.workspace.applyEdit(edit), true);
				assert.ok(changes > 0);
				assert.ok(String(tree.getTreeItem(tree.getChildren()[0]).description).includes('modified'));
				assert.notEqual(tree.getTreeItem(node).contextValue, 'cargo-deps.updatable');
				const changedItem = await tree.resolveTreeItem(tree.getTreeItem(node), node, token.token);
				assert.ok(String(changedItem.tooltip).includes('Save'));
				await assert.rejects(prepareDependencyUpdates(model, [node]), /Save/);
				await model.addManifest(source.snapshot.root, source.document.getText());
				await assert.rejects(prepareDependencyUpdates(model, [node]), /analysis changed/);
			} finally {
				subscription.dispose();
			}
		} finally {
			token.dispose();
			tree.dispose();
			model.dispose();
		}
	});

	test('updates a shared inherited declaration once without editing member manifests or a same-named root dependency', async () => {
		const model = new TestAnalysis();
		try {
			const contents = [
				'[package]', 'name = "host"', 'version = "0.1.0"',
				'[workspace.dependencies]', 'transport = { package = "serde", version = "^1.0" }',
				'[dependencies]', 'transport = { package = "serde", version = "0.5.0" }',
			].join('\n');
			const workspace = await manifest(contents, [], model);
			const context = workspace.dependencies.map(health => health.dependency);
			const members = await Promise.all([
				manifest('[dependencies]\ntransport.workspace = true', context, model),
				manifest('[dependencies.transport]\nworkspace = true', context, model),
			]);
			for (const member of members) {
				member.snapshot.workspaceRoot = workspace.snapshot.root;
			}
			const declaration = workspace.dependencies.find(health => health.dependency.workspace === 'declaration')!;
			const requests = [
				{ snapshot: workspace.snapshot, health: declaration },
				...members.map(member => ({ snapshot: member.snapshot, health: member.dependencies[0] })),
			];
			const plan = await prepareDependencyUpdates(model, requests);
			assert.equal(plan.count, 1);
			assert.equal(plan.edit.entries().length, 1);
			assert.equal(workspace.document.getText(), contents);
			await applyDependencyUpdates(model, plan);
			assert.equal(workspace.document.getText(), contents.replace('version = "^1.0"', 'version = "^2.0.0"'));
			assert.equal(workspace.document.isDirty, true);
			assert.equal(await readFile(workspace.uri.fsPath, 'utf8'), contents);
			assert.equal(members[0].document.getText(), '[dependencies]\ntransport.workspace = true');
			assert.equal(members[1].document.getText(), '[dependencies.transport]\nworkspace = true');
			model.forget(workspace.snapshot.root);
			await assert.rejects(prepareDependencyUpdates(model, [requests[1]]), /Workspace declaration/);
		} finally {
			model.dispose();
		}
	});

	test('applies only the chosen crate scope and refuses an entire prepared batch after a manifest edit', async () => {
		const model = new TestAnalysis();
		const updates = new DependencyTreeProvider('updates', model);
		try {
			const app = await manifest('[dependencies]\nserde = "1.0"', [], model);
			const worker = await manifest('[dependencies]\ntokio = "1.0"', [], model);
			const batch = await prepareDependencyUpdates(model, updates.getUpdateRequests());
			assert.equal(batch.count, 2);
			const edit = new vscode.WorkspaceEdit();
			edit.insert(worker.uri, new vscode.Position(0, 0), '# User edit\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			await assert.rejects(applyDependencyUpdates(model, batch), /changed/);
			assert.equal(app.document.getText(), '[dependencies]\nserde = "1.0"');
			assert.equal(worker.document.getText(), '# User edit\n[dependencies]\ntokio = "1.0"');
			updates.setFilter(app.snapshot.root);
			const scoped = await prepareDependencyUpdates(model, updates.getUpdateRequests());
			await applyDependencyUpdates(model, scoped);
			assert.equal(app.document.getText(), '[dependencies]\nserde = "2.0.0"');
			assert.equal(worker.document.getText(), '# User edit\n[dependencies]\ntokio = "1.0"');
		} finally {
			updates.dispose();
			model.dispose();
		}
	});

	test('refuses prepared panel updates if the analysis is replaced during confirmation', async () => {
		const model = new TestAnalysis();
		try {
			const source = await manifest('[dependencies]\nserde = "1.0"', [], model);
			const request = { snapshot: source.snapshot, health: source.dependencies[0] };
			const plan = await prepareDependencyUpdates(model, [request]);
			await model.addManifest(source.snapshot.root, source.document.getText());
			await assert.rejects(applyDependencyUpdates(model, plan), /analysis changed/);
			assert.equal(source.document.getText(), '[dependencies]\nserde = "1.0"');
		} finally {
			model.dispose();
		}
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
});
