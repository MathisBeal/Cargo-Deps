import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildDiagnostics } from '../providers/diagnosticsProvider';
import { DependencyAnalysisService } from '../services/analysis';
import { CratesIoService } from '../services/cratesIo';
import { isOutdated } from '../providers/hintsProvider';
import { formatDependencyPath } from '../providers/hoverProvider';
import { CargoService, parseAuditReport, parseCargoJson } from '../services/cargo';
import { parseDependencies } from '../services/manifest';

suite('Extension Test Suite', () => {
	test('renders the shortest dependency path without unrelated branches or depth prefixes', () => {
		const tree = [
			'0ttf-parser v0.25.1',
			'1owned_ttf_parser v0.25.1',
			'2ab_glyph v0.2.32',
			'3sctk-adwaita v0.10.1',
			'4winit v0.30.13',
			'5accesskit_winit v0.32.2',
			'6egui-winit v0.36.2',
			'7eframe v0.36.2',
			'8demo_app v1.2.0 (/example/demo_app)',
			'5eframe v0.36.2 (*)',
			'5egui-wgpu v0.36.2',
			'6eframe v0.36.2 (*)',
		].join('\n');
		assert.strictEqual(formatDependencyPath(tree, 'eframe'), [
			'eframe v0.36.2',
			'└─ winit v0.30.13',
			'  └─ sctk-adwaita v0.10.1',
			'    └─ ab_glyph v0.2.32',
			'      └─ owned_ttf_parser v0.25.1',
			'        └─ ttf-parser v0.25.1',
		].join('\n'));
	});

	test('connects repeated subtrees without mixing sibling branches', () => {
		const tree = [
			'0paste v1.0.15 (proc-macro)',
			'1stackbox v0.2.2',
			'2egui_taffy v0.14.0',
			'3demo_lib v1.2.0 (/example/demo_lib)',
			'1other v1.0.0',
			'2stackbox v0.2.2 (*)',
		].join('\n');
		assert.strictEqual(formatDependencyPath(tree, 'egui_taffy'), [
			'egui_taffy v0.14.0',
			'└─ stackbox v0.2.2',
			'  └─ paste v1.0.15',
		].join('\n'));
		assert.strictEqual(formatDependencyPath(tree, 'missing'), undefined);
		assert.strictEqual(formatDependencyPath('', 'eframe'), undefined);
	});

	test('analyzes closed workspace manifests with a shared audit and inherited versions', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-'));
		const member = path.join(root, 'member');
		let auditCalls = 0;
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { auditCalls++; return []; }
			override async outdated() { return []; }
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion: '4.10.1', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const collection = vscode.languages.createDiagnosticCollection('cargo-deps-batch-test');
		const subscription = analysis.onDidAnalyze(snapshot => {
			collection.set(vscode.Uri.file(path.join(snapshot.root, 'Cargo.toml')), buildDiagnostics(snapshot));
		});
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["member"]\n[workspace.dependencies]\nserialport = "4.9.0"');
			await writeFile(path.join(member, 'Cargo.toml'), '[package]\nname = "member"\nversion = "0.1.0"\n[dependencies]\nserialport.workspace = true');
			await analysis.refreshAll([root, member, member]);
			assert.strictEqual(auditCalls, 1);
			for (const manifestRoot of [root, member]) {
				const uri = vscode.Uri.file(path.join(manifestRoot, 'Cargo.toml'));
				assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString()));
				assert.strictEqual(analysis.getSnapshot(manifestRoot)?.dependencies[0].installedVersion, '4.9.0');
				assert.strictEqual(collection.get(uri)?.[0].severity, vscode.DiagnosticSeverity.Information);
			}
			assert.strictEqual(collection.get(vscode.Uri.file(path.join(member, 'Cargo.toml')))?.[0].range.start.line, 4);
			analysis.forget(member);
			assert.strictEqual(analysis.getSnapshot(member), undefined);
		} finally {
			subscription.dispose();
			collection.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('publishes info on the version and warnings for transitive advisories', async () => {
		const contents = '[dependencies]\neframe = { version = "0.36.2" }';
		const dependencies = await parseDependencies(contents);
		const diagnostics = buildDiagnostics({
			root: '/example', contents, updatedAt: 0,
			dependencies: [{
				dependency: dependencies[0], installedVersion: '0.36.2', latestVersion: '0.37.0', versions: [],
				advisories: [{
					id: 'RUSTSEC-2026-0192', title: 'ttf-parser is unmaintained', severity: 'unmaintained',
					packageName: 'ttf-parser', packageVersion: '0.25.1',
				}],
			}],
		});
		assert.strictEqual(diagnostics.length, 2);
		assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Information);
		assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Warning);
		assert.ok(diagnostics[1].message.includes('eframe -> ttf-parser 0.25.1'));
		for (const diagnostic of diagnostics) {
			assert.strictEqual(diagnostic.source, 'cargo-deps');
			assert.strictEqual(diagnostic.range.start.line, 1);
			assert.strictEqual(contents.split('\n')[1].slice(diagnostic.range.start.character, diagnostic.range.end.character), '0.36.2');
		}
		const collection = vscode.languages.createDiagnosticCollection('cargo-deps-test');
		try {
			const uri = vscode.Uri.file('/example/Cargo.toml');
			collection.set(uri, diagnostics);
			assert.strictEqual(collection.get(uri)?.length, 2);
			collection.set(uri, []);
			assert.strictEqual(collection.get(uri)?.length, 0);
		} finally {
			collection.dispose();
		}
	});

	test('locates inherited diagnostics and skips updates for local or current dependencies', async () => {
		const contents = '[dependencies]\ntracing.workspace = true\ncommons = { path = "../commons", version = "1.2.0" }';
		const dependencies = await parseDependencies(contents);
		const snapshot = {
			root: '/example', contents, updatedAt: 0,
			dependencies: dependencies.map(dependency => ({
				dependency, installedVersion: '1.2.0', latestVersion: '1.3.0', versions: [], advisories: [],
			})),
		};
		const diagnostics = buildDiagnostics(snapshot);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].range.start.line, 1);
		assert.strictEqual(contents.split('\n')[1].slice(diagnostics[0].range.start.character, diagnostics[0].range.end.character), 'true');
		snapshot.dependencies[0].latestVersion = '1.2.0';
		assert.deepStrictEqual(buildDiagnostics(snapshot), []);
	});

	test('parses direct, aliased, and target-specific dependencies without comments', async () => {
		const contents = [
			'# fake = "9.9.9"',
			'[dependencies]',
			'serde = "^1.0" # serde = "9.9.9"',
			'"fast-hash" = { package = "hashbrown", version = "0.15", features = ["raw"] }',
			'[dependencies.legacy]',
			'version = "0.4"',
			'[dev-dependencies]',
			'insta = { version = "1.0", default-features = false }',
			"[target.'cfg(target_os = \"linux\")'.dependencies]",
			'libc = "0.2"',
		].join('\n');

		const dependencies = await parseDependencies(contents);
		assert.deepStrictEqual(dependencies.map(dependency => ({
			name: dependency.name,
			packageName: dependency.packageName,
			versionRequirement: dependency.versionRequirement,
			line: dependency.line,
		})), [
			{ name: 'serde', packageName: 'serde', versionRequirement: '^1.0', line: 2 },
			{ name: 'fast-hash', packageName: 'hashbrown', versionRequirement: '0.15', line: 3 },
			{ name: 'legacy', packageName: 'legacy', versionRequirement: '0.4', line: 5 },
			{ name: 'insta', packageName: 'insta', versionRequirement: '1.0', line: 7 },
			{ name: 'libc', packageName: 'libc', versionRequirement: '0.2', line: 9 },
		]);
	});

	test('resolves workspace-inherited dependency versions and package aliases', async () => {
		const workspaceDependencies = await parseDependencies([
			'[workspace.dependencies]',
			'serialport = "4.9.0"',
			'"serial-port" = { package = "serialport", version = "4.8.0" }',
		].join('\n'));
		const memberDependencies = await parseDependencies([
			'[dependencies]',
			'serialport.workspace = true',
			'"serial-port" = { workspace = true, optional = true }',
		].join('\n'), workspaceDependencies);

		assert.deepStrictEqual(memberDependencies.map(dependency => ({
			name: dependency.name,
			packageName: dependency.packageName,
			versionRequirement: dependency.versionRequirement,
			line: dependency.line,
		})), [
			{ name: 'serialport', packageName: 'serialport', versionRequirement: '4.9.0', line: 1 },
			{ name: 'serial-port', packageName: 'serialport', versionRequirement: '4.8.0', line: 2 },
		]);
	});

	test('marks path dependencies as local instead of treating them as crates.io crates', async () => {
		const dependencies = await parseDependencies([
			'[dependencies]',
			'commons = { path = "../commons", version = "1.2.0" }',
		].join('\n'));

		assert.deepStrictEqual(dependencies.map(dependency => ({
			name: dependency.name,
			packageName: dependency.packageName,
			versionRequirement: dependency.versionRequirement,
			localPath: dependency.localPath,
		})), [{
			name: 'commons',
			packageName: 'commons',
			versionRequirement: '1.2.0',
			localPath: '../commons',
		}]);
	});

	test('does not mark an installed latest version as outdated', () => {
		assert.strictEqual(isOutdated('1.2.3', '1.2.3'), false);
		assert.strictEqual(isOutdated('1.2.2', '1.2.3'), true);
	});

	test('parses cargo audit unmaintained warnings', () => {
		const advisories = parseAuditReport({
			vulnerabilities: { list: [] },
			warnings: {
				unmaintained: [{
					kind: 'unmaintained',
					package: { name: 'ttf-parser', version: '0.25.1' },
					advisory: { id: 'RUSTSEC-2026-0192', title: '`ttf-parser` is unmaintained', informational: 'unmaintained' },
				}],
			},
		});

		assert.deepStrictEqual(advisories, [{
			packageName: 'ttf-parser',
			packageVersion: '0.25.1',
			id: 'RUSTSEC-2026-0192',
			title: '`ttf-parser` is unmaintained',
			severity: 'unmaintained',
		}]);
	});

	test('parses cargo outdated newline-delimited JSON', () => {
		assert.deepStrictEqual(parseCargoJson([
			'{"crate_name":"demo_app","dependencies":[{"name":"serialport","project":"4.9.0","latest":"4.10.1"}]}',
			'{"crate_name":"driver_commons","dependencies":[{"name":"serialport","project":"4.9.0","latest":"4.10.1"}]}',
		].join('\n')), [
			{ crate_name: 'demo_app', dependencies: [{ name: 'serialport', project: '4.9.0', latest: '4.10.1' }] },
			{ crate_name: 'driver_commons', dependencies: [{ name: 'serialport', project: '4.9.0', latest: '4.10.1' }] },
		]);
	});
});
