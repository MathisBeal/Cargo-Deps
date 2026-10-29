import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildDiagnostics } from '../providers/diagnosticsProvider';
import { DependencyAnalysisService } from '../services/analysis';
import { CratesIoService } from '../services/cratesIo';
import { isOutdated } from '../providers/hintsProvider';
import { formatDependencyPath } from '../providers/hoverProvider';
import { CargoCommandError, CargoService, parseAuditReport, parseCargoJson } from '../services/cargo';
import { parseDependencies } from '../services/manifest';
import { AnalysisStatusBar, buildAnalysisStatus } from '../providers/statusBar';
import { AnalysisProgressTracker } from '../services/progress';
import type { AnalysisProgress, CratesIoProgress } from '../services/progress';
import type { CargoAuditEntry } from '../types';
import { AnalysisOutput } from '../providers/output';
import { SET_VERSION_COMMAND } from '../services/updates';

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>(settle => { resolve = settle; });
	return { promise, resolve };
}

function waitForProgress(analysis: DependencyAnalysisService, predicate: (progress: AnalysisProgress) => boolean): Promise<AnalysisProgress> {
	return new Promise(resolve => {
		const subscription = analysis.onDidProgress(progress => {
			if (predicate(progress)) {
				subscription.dispose();
				resolve(progress);
			}
		});
	});
}

suite('Extension Test Suite', () => {
	test('treats a package outside the selected member as absent while preserving real Cargo failures', async function () {
		if (spawnSync('cargo', ['--version'], { timeout: 5_000 }).status !== 0) {
			this.skip();
		}
		this.timeout(15_000);
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-tree-scope-'));
		const cargo = new CargoService();
		try {
			await writeFile(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["app", "driver", "affected"]\nresolver = "2"');
			for (const name of ['app', 'driver', 'affected']) {
				const member = path.join(root, name);
				await mkdir(path.join(member, 'src'), { recursive: true });
				await writeFile(path.join(member, 'src', 'lib.rs'), '');
				await writeFile(path.join(member, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.25.1"\nedition = "2021"\n${name === 'app' ? '[dependencies]\naffected = { path = "../affected" }' : ''}`);
			}
			const affected = await cargo.inverseTree(path.join(root, 'app'), 'affected', '0.25.1');
			assert.ok(affected.includes('0affected v0.25.1'));
			assert.ok(affected.includes('1app v0.25.1'));
			assert.strictEqual(await cargo.inverseTree(path.join(root, 'driver'), 'affected', '0.25.1'), '');
			await assert.rejects(cargo.inverseTree(path.join(root, 'missing'), 'affected', '0.25.1'), CargoCommandError);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('shares each package-version trace across advisories without contaminating unrelated members or names', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-advisory-scope-'));
		const member = path.join(root, 'member');
		const calls = new Map<string, number>();
		const entries = [
			{ id: 'RUSTSEC-TEST-0001', packageName: 'ttf-parser', packageVersion: '0.25.1', title: 'First advisory' },
			{ id: 'RUSTSEC-TEST-0002', packageName: 'ttf-parser', packageVersion: '0.25.1', title: 'Second advisory' },
			{ id: 'RUSTSEC-TEST-0003', packageName: 'tokio', packageVersion: '1.54.0', title: 'New tokio' },
			{ id: 'RUSTSEC-TEST-0004', packageName: 'tokio', packageVersion: '1.53.0', title: 'Old tokio' },
		];
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { return entries; }
			override async outdated() { return []; }
			override async inverseTree(manifestRoot: string, name: string, version: string) {
				const key = `${manifestRoot}:${name}@${version}`;
				calls.set(key, (calls.get(key) ?? 0) + 1);
				return manifestRoot === member ? '' : `0${name} v${version}\n1driver_commons v1.2.0\n2app v1.2.0`;
			}
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion: '1.2.0', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const progress: AnalysisProgress[] = [];
		const subscription = analysis.onDidProgress(event => progress.push(event));
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), '[workspace.dependencies]\ncommons = { path = "./commons", version = "1.2.0" }\ntransport = { package = "driver_commons", version = "1.2.0" }');
			await writeFile(path.join(member, 'Cargo.toml'), '[dependencies]\ncommons.workspace = true\ntransport.workspace = true');
			await analysis.refreshAll([root, member]);
			const rootHealth = analysis.getSnapshot(root)!.dependencies;
			assert.strictEqual(rootHealth.find(health => health.dependency.name === 'commons')?.advisories.length, 0);
			assert.deepStrictEqual(rootHealth.find(health => health.dependency.name === 'transport')?.advisories.map(advisory => advisory.id), entries.map(entry => entry.id));
			assert.ok(analysis.getSnapshot(member)!.dependencies.every(health => health.advisories.length === 0));
			assert.strictEqual(calls.size, 6);
			assert.ok([...calls.values()].every(count => count === 1));
			const final = progress[progress.length - 1];
			assert.deepStrictEqual(final.errors, []);
			const tree = final.steps.find(step => step.id === 'tree')!;
			assert.strictEqual(tree.status, 'completed');
			assert.strictEqual(tree.total, 3);
			assert.strictEqual(tree.completed, 3);
			assert.ok(tree.detail?.includes('3 package(s) not used by this manifest'));
		} finally {
			subscription.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('logs every full error once and preserves logs across refreshes', () => {
		const tracker = new AnalysisProgressTracker();
		const errors: Array<{ message: string; args: unknown[] }> = [];
		const messages: string[] = [];
		let shown = 0;
		let disposed = false;
		const output = new AnalysisOutput(tracker.onDidChange, {
			info: message => { messages.push(message); },
			error: (message, ...args: unknown[]) => { errors.push({ message: String(message), args }); },
			show: () => { shown++; },
			dispose: () => { disposed = true; },
		});
		const item = vscode.window.createStatusBarItem('cargo-deps-log-test');
		const status = new AnalysisStatusBar(tracker.onDidChange, item);
		let latest: AnalysisProgress | undefined;
		const subscription = tracker.onDidChange(progress => { latest = progress; });
		try {
			tracker.begin(1);
			tracker.manifest('/example');
			tracker.update('outdated', { status: 'running', active: ['/example'] });
			for (let index = 0; index < 12; index++) {
				tracker.recordError(`Failure ${index}\nFull stderr line\nExtra detail`);
			}
			tracker.update('crates', { completed: 4 });
			tracker.manifestCompleted();
			tracker.finish();
			assert.strictEqual(errors.length, 12);
			assert.ok(errors[11].message.includes('Failure 11\nFull stderr line\nExtra detail'));
			assert.ok(errors[11].message.includes(path.join('/example', 'Cargo.toml')));
			assert.ok(messages.some(message => message.includes('[cargo outdated] running')));
			assert.ok(messages.some(message => message.includes('12 error(s)')));
			assert.strictEqual(item.command, 'cargo-deps.showOutput');
			const tooltip = buildAnalysisStatus(latest!).tooltip;
			assert.ok(tooltip.value.includes('4 more errors'));
			assert.ok(tooltip.value.includes('command:cargo-deps.showOutput'));
			assert.deepStrictEqual(tooltip.isTrusted, { enabledCommands: ['cargo-deps.showOutput'] });
			output.show();
			assert.strictEqual(shown, 1);
			tracker.begin(1);
			tracker.manifest('/example');
			tracker.recordError('New scan failure');
			assert.strictEqual(errors.length, 13);
			assert.ok(errors[12].message.includes('New scan failure'));
			output.error('Workspace discovery failed', new Error('Filesystem unavailable'));
			assert.strictEqual(errors[13].message, 'Workspace discovery failed');
			assert.ok(errors[13].args[0] instanceof Error);
			output.dispose();
			tracker.recordError('After disposal');
			assert.strictEqual(errors.length, 14);
			assert.strictEqual(disposed, true);
			status.discover();
			assert.strictEqual(item.command, 'cargo-deps.refresh');
			status.fail('Discovery failed');
			assert.strictEqual(item.command, 'cargo-deps.showOutput');
		} finally {
			subscription.dispose();
			status.dispose();
			tracker.dispose();
		}
	});

	test('includes HTTP response details, URL and network causes in release lookup errors', async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => Response.json({ errors: [{ detail: 'Too many requests' }] }, { status: 429 });
			await assert.rejects(new CratesIoService().getReleaseInfo('serde'), error => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /HTTP 429/);
				assert.match(error.message, /Too many requests/);
				assert.match(error.message, /GET https:\/\/crates.io\/api\/v1\/crates\/serde/);
				return true;
			});
			globalThis.fetch = async () => { throw new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND crates.io') }); };
			await assert.rejects(new CratesIoService().getReleaseInfo('serde'), /getaddrinfo ENOTFOUND crates.io/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('reports parallel commands, active trees, HTTP progress and cached lookups in the status bar', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-progress-'));
		const audit = deferred<CargoAuditEntry[]>();
		const outdated = deferred<[]>();
		const tree = deferred<string>();
		const responses = deferred<void>();
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = async input => {
			fetchCalls++;
			await responses.promise;
			return Response.json(String(input).includes('/versions')
				? { versions: [{ num: '0.37.0', created_at: '2026-10-01', yanked: false }] }
				: { crate: { max_version: '0.37.0' } });
		};
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { return audit.promise; }
			override async outdated() { return outdated.promise; }
			override async inverseTree() { return tree.promise; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new CratesIoService());
		const item = vscode.window.createStatusBarItem('cargo-deps-progress-test');
		const status = new AnalysisStatusBar(analysis.onDidProgress, item);
		const events: AnalysisProgress[] = [];
		const subscription = analysis.onDidProgress(progress => events.push(progress));
		let operation: Promise<void> | undefined;
		try {
			await writeFile(path.join(root, 'Cargo.toml'), '[dependencies]\neframe = "0.36.2"\nalias = { package = "eframe", version = "0.36.2" }\ncommons = { path = "../commons", version = "1.0" }');
			status.discover();
			assert.ok(item.text.includes('finding manifests'));
			assert.strictEqual(item.command, 'cargo-deps.refresh');
			const parallel = waitForProgress(analysis, progress => ['audit', 'outdated'].every(id => progress.steps.some(step => step.id === id && step.status === 'running')));
			operation = analysis.refreshAll([root]);
			await parallel;
			assert.ok(item.text.includes('cargo audit + cargo outdated'));
			const treeActive = waitForProgress(analysis, progress => progress.steps.some(step => step.id === 'tree' && step.active.includes('ttf-parser@0.25.1')));
			audit.resolve([{
				id: 'RUSTSEC-2026-0192', title: 'Unmaintained', severity: 'unmaintained',
				packageName: 'ttf-parser', packageVersion: '0.25.1',
			}]);
			outdated.resolve([]);
			await treeActive;
			const requestsActive = waitForProgress(analysis, progress => progress.requestsTotal === 2 && progress.steps.some(step => step.id === 'crates' && step.active.length === 2));
			tree.resolve('0ttf-parser v0.25.1\n1eframe v0.36.2');
			const requests = await requestsActive;
			assert.strictEqual(requests.requestsCompleted, 0);
			assert.deepStrictEqual(requests.activeCrates, ['eframe']);
			assert.strictEqual(requests.steps.find(step => step.id === 'crates')?.total, 1);
			const view = buildAnalysisStatus(requests);
			assert.ok(view.tooltip.value.includes('https://crates.io/api/v1/crates/eframe'));
			assert.ok(view.tooltip.value.includes('0/2'));
			assert.ok(view.tooltip.value.includes('run in parallel'));
			responses.resolve();
			await operation;
			const completed = events[events.length - 1];
			assert.strictEqual(completed.status, 'completed');
			assert.strictEqual(completed.requestsCompleted, 2);
			assert.strictEqual(completed.requestsTotal, 2);
			assert.strictEqual(completed.manifestsCompleted, 1);
			assert.deepStrictEqual(completed.activeCrates, []);
			assert.ok(completed.steps.every(step => step.status === 'completed'));
			assert.strictEqual(fetchCalls, 2);
			assert.ok(!item.text.includes('~spin'));
			assert.strictEqual(item.backgroundColor, undefined);
			assert.deepStrictEqual(view.tooltip.isTrusted, { enabledCommands: ['cargo-deps.showOutput'] });
			assert.ok(!requests.finishedAt);
			await analysis.refreshAll([root]);
			const cached = events[events.length - 1];
			assert.strictEqual(cached.cacheHits, 1);
			assert.strictEqual(cached.requestsTotal, 0);
			assert.strictEqual(fetchCalls, 2);
		} finally {
			audit.resolve([]);
			outdated.resolve([]);
			tree.resolve('');
			responses.resolve();
			await operation?.catch(() => undefined);
			globalThis.fetch = originalFetch;
			subscription.dispose();
			status.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('waits for both HTTP endpoints on failure and reports shared requests without double counting', async () => {
		const originalFetch = globalThis.fetch;
		const response = deferred<void>();
		const failedRequest = deferred<void>();
		const events: CratesIoProgress[] = [];
		let fetchCalls = 0;
		globalThis.fetch = async input => {
			fetchCalls++;
			if (!String(input).includes('/versions')) {
				return new Response('', { status: 503 });
			}
			await response.promise;
			return Response.json({ versions: [] });
		};
		const service = new CratesIoService();
		const first = service.getReleaseInfo('broken', event => {
			events.push(event);
			if (event.kind === 'request' && event.status === 'failed') {
				failedRequest.resolve();
			}
		});
		const sharedEvents: CratesIoProgress[] = [];
		const shared = service.getReleaseInfo('broken', event => sharedEvents.push(event));
		let settled = false;
		const firstResult = first.catch(error => { settled = true; return error; });
		const sharedResult = shared.catch(error => error);
		try {
			await failedRequest.promise;
			assert.strictEqual(settled, false);
			assert.deepStrictEqual(sharedEvents, [{ kind: 'shared' }]);
			response.resolve();
			assert.match((await firstResult).message, /HTTP 503/);
			assert.match((await sharedResult).message, /HTTP 503/);
			assert.strictEqual(fetchCalls, 2);
			assert.strictEqual(events.filter(event => event.kind === 'request' && event.status !== 'running').length, 2);
		} finally {
			response.resolve();
			await Promise.all([firstResult, sharedResult]);
			globalThis.fetch = originalFetch;
		}
	});

	test('keeps partial failures visible across manifests and clears them on the next scan', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-errors-'));
		const member = path.join(root, 'member');
		let fail = true;
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { if (fail) { throw new Error('Audit unavailable'); } return []; }
			override async outdated() { if (fail) { throw new Error('Outdated unavailable'); } return []; }
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { if (fail) { throw new Error('Network unavailable'); } return { latestVersion: '1.0.0', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const events: AnalysisProgress[] = [];
		const subscription = analysis.onDidProgress(progress => events.push(progress));
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), '[workspace.dependencies]\nserde = "1.0.0"');
			await writeFile(path.join(member, 'Cargo.toml'), '[dependencies]\nserde.workspace = true');
			await analysis.refreshAll([root, member]);
			const partial = events[events.length - 1];
			assert.strictEqual(partial.status, 'completed');
			assert.strictEqual(partial.manifestsCompleted, 2);
			assert.strictEqual(partial.steps.find(step => step.id === 'audit')?.status, 'failed');
			assert.strictEqual(partial.steps.find(step => step.id === 'outdated')?.status, 'failed');
			assert.strictEqual(partial.steps.find(step => step.id === 'crates')?.status, 'failed');
			assert.strictEqual(partial.steps.find(step => step.id === 'tree')?.status, 'skipped');
			assert.ok(buildAnalysisStatus(partial).text.includes('partial results'));
			assert.ok(!buildAnalysisStatus(partial).text.includes('~spin'));
			assert.ok(analysis.getSnapshot(member));
			fail = false;
			await analysis.refreshAll([root, member]);
			const success = events[events.length - 1];
			assert.deepStrictEqual(success.errors, []);
			assert.strictEqual(success.steps.find(step => step.id === 'audit')?.status, 'completed');
			assert.strictEqual(buildAnalysisStatus(success).text, '$(check) Cargo Deps');
		} finally {
			subscription.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('reports manifest and tree failures without leaving running steps behind', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-invalid-'));
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() {
				return [{ id: 'RUSTSEC-2026-0192', title: 'Unmaintained', packageName: 'ttf-parser', packageVersion: '0.25.1' }];
			}
			override async outdated() { return []; }
			override async inverseTree(): Promise<string> { throw new Error('Tree unavailable'); }
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion: '0.37.0', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const events: AnalysisProgress[] = [];
		const subscription = analysis.onDidProgress(progress => events.push(progress));
		try {
			await writeFile(path.join(root, 'Cargo.toml'), '[dependencies]\neframe = {');
			await analysis.refresh(root);
			const invalid = events[events.length - 1];
			assert.strictEqual(invalid.steps[0].status, 'failed');
			assert.ok(invalid.steps.slice(1).every(step => step.status === 'skipped'));
			assert.ok(!buildAnalysisStatus(invalid).text.includes('~spin'));
			await writeFile(path.join(root, 'Cargo.toml'), '[dependencies]\neframe = "0.36.2"');
			await analysis.refresh(root);
			const treeFailure = events[events.length - 1];
			const step = treeFailure.steps.find(candidate => candidate.id === 'tree');
			assert.strictEqual(step?.status, 'failed');
			assert.strictEqual(step.completed, 1);
			assert.strictEqual(step.total, 1);
			assert.ok(treeFailure.errors.some(error => error.includes('Tree unavailable')));
			assert.ok(treeFailure.steps.every(candidate => candidate.status !== 'running'));
			assert.ok(buildAnalysisStatus(treeFailure).text.includes('partial results'));
		} finally {
			subscription.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('settles progress on fatal failure and empty workspaces', async () => {
		const tracker = new AnalysisProgressTracker();
		const events: AnalysisProgress[] = [];
		const subscription = tracker.onDidChange(progress => events.push(progress));
		try {
			tracker.begin(1);
			tracker.update('audit', { status: 'running', active: ['workspace'] });
			tracker.finish('Unexpected failure');
			const failure = events[events.length - 1];
			assert.strictEqual(failure.status, 'failed');
			assert.ok(failure.steps.every(step => step.status !== 'running'));
			assert.ok(!buildAnalysisStatus(failure).text.includes('~spin'));
			assert.strictEqual(events[0].status, 'running');
			assert.strictEqual(events[0].errors.length, 0);
			tracker.begin(0);
			tracker.finish();
			assert.strictEqual(events[events.length - 1].manifestsTotal, 0);
		} finally {
			subscription.dispose();
			tracker.dispose();
		}
	});

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

	test('contributes both bulk update commands to the F1 command palette', async () => {
		const extension = vscode.extensions.getExtension('MathisBEAL.cargo-deps');
		assert.ok(extension);
		assert.ok(!vscode.workspace.textDocuments.some(document => path.basename(document.uri.fsPath) === 'Cargo.toml'));
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['cargo-deps.updateOpen', 'cargo-deps.updateAll']) {
			assert.ok(commands.includes(command));
			assert.ok(extension.packageJSON.contributes.commands.some((item: { command: string }) => item.command === command));
		}
		assert.ok(commands.includes(SET_VERSION_COMMAND));
	});
});
