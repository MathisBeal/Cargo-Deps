import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDiagnostics } from '../providers/diagnosticsProvider';
import { DependencyAnalysisService } from '../services/analysis';
import { CratesIoService } from '../services/cratesIo';
import { isOutdated } from '../providers/hintsProvider';
import { formatDependencyPath } from '../providers/hoverProvider';
import { CargoCommandError, CargoService, parseAuditReport, parseCargoJson, parseOutdatedReport } from '../services/cargo';
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
	test('aborts the running Cargo subprocess instead of waiting for its timeout', async () => {
		const started = deferred<void>();
		const closed = deferred<void>();
		const controller = new AbortController();
		const execute = promisify(execFile);
		const cargo = new CargoService((_file, _args, options) => {
			const command = execute('node', ['-e', 'setInterval(() => {}, 1000)'], options);
			command.child.once('spawn', () => started.resolve());
			command.child.once('close', () => closed.resolve());
			return command;
		});
		const result = cargo.outdated(process.cwd(), true, controller.signal).catch(error => error);
		try {
			await started.promise;
			controller.abort();
			assert.strictEqual((await result).name, 'AbortError');
			await closed.promise;
		} finally {
			controller.abort();
			await result;
		}
	});

	test('preserves Cargo errors with partial stdout and accepts only completed vulnerability reports', async () => {
		const report = JSON.stringify({ vulnerabilities: { list: [] }, warnings: {} });
		let failure: { code: number; killed: boolean; signal?: string; stdout: string; stderr: string } = {
			code: 1, killed: false, stdout: report, stderr: 'command failed',
		};
		const cargo = new CargoService(async (_file, args) => {
			if (args[0] === 'locate-project') {
				return { stdout: path.join('/example', 'Cargo.toml'), stderr: '' };
			}
			throw Object.assign(new Error('command failed'), failure);
		});
		assert.deepStrictEqual(await cargo.audit('/example'), []);
		await assert.rejects(cargo.outdated('/example'), /command failed/);
		await assert.rejects(cargo.inverseTree('/example', 'serde', '1.0.0'), /command failed/);
		failure = { ...failure, killed: true, signal: 'SIGTERM' };
		await assert.rejects(cargo.audit('/example'), CargoCommandError);
		failure = { ...failure, killed: false, signal: undefined, stdout: '{}' };
		await assert.rejects(cargo.audit('/example'), /invalid audit report/);
		const unavailable = new CargoService(async () => { throw new Error('Cargo executable unavailable'); });
		await assert.rejects(unavailable.workspaceRoot('/example'), /Cargo executable unavailable/);
	});

	test('treats a package outside the selected member as absent while preserving real Cargo failures', async function () {
		if (spawnSync('cargo', ['--version'], { timeout: 5_000 }).status !== 0) {
			this.skip();
		}
		this.timeout(60_000);
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-tree-scope-'));
		const execute = promisify(execFile);
		const cargo = new CargoService((file, args, options) => execute(file, ['--offline', ...args], options));
		const signal = AbortSignal.timeout(45_000);
		try {
			await writeFile(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["app", "driver", "affected"]\nresolver = "2"');
			for (const name of ['app', 'driver', 'affected']) {
				const member = path.join(root, name);
				await mkdir(path.join(member, 'src'), { recursive: true });
				await writeFile(path.join(member, 'src', 'lib.rs'), '');
				await writeFile(path.join(member, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.25.1"\nedition = "2021"\n${name === 'app' ? '[dependencies]\naffected = { path = "../affected" }' : ''}`);
			}
			const affected = await cargo.inverseTree(path.join(root, 'app'), 'affected', '0.25.1', signal);
			assert.ok(affected.includes('0affected v0.25.1'));
			assert.ok(affected.includes('1app v0.25.1'));
			assert.strictEqual(await cargo.inverseTree(path.join(root, 'driver'), 'affected', '0.25.1', signal), '');
			await assert.rejects(cargo.inverseTree(path.join(root, 'missing'), 'affected', '0.25.1', signal), CargoCommandError);
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
			assert.strictEqual(item.command, 'cargo-deps.refresh');
			assert.ok(buildAnalysisStatus(latest!).tooltip.value.includes('Click the status bar to restart analysis.'));
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
			assert.ok(tooltip.value.includes('12 analysis errors'));
			assert.ok(!tooltip.value.includes('Full stderr line'));
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
			assert.ok(view.tooltip.value.includes('Loading published versions (0/1)'));
			assert.ok(view.tooltip.value.includes('- $(sync~spin) Loading published versions (0/1) - running'));
			assert.strictEqual((view.tooltip.value.match(/\*\*\d+%\*\*/g) ?? []).length, 1);
			assert.ok(!view.tooltip.value.includes('https://crates.io'));
			assert.ok(!view.tooltip.value.includes('HTTP'));
			assert.ok(!view.tooltip.value.includes('Cache hits'));
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

	test('keeps the workspace bar and lists manifest steps with their states and counts', () => {
		const tracker = new AnalysisProgressTracker();
		let latest!: AnalysisProgress;
		const subscription = tracker.onDidChange(progress => { latest = progress; });
		try {
			tracker.begin(2);
			tracker.manifest('/example/first');
			assert.ok(buildAnalysisStatus(latest).tooltip.value.includes('`[--------------------]` **0%**'));
			for (const step of ['manifest', 'audit', 'outdated', 'tree', 'crates'] as const) {
				tracker.update(step, { status: 'completed' });
			}
			tracker.manifestCompleted();
			let tooltip = buildAnalysisStatus(latest).tooltip.value;
			assert.ok(tooltip.includes('1/2 manifests processed'));
			assert.ok(tooltip.includes('`[==========----------]` **50%**'));
			assert.ok(tooltip.includes('- $(check) Reading manifest - completed'));
			assert.ok(!tooltip.includes('**100%**'));

			tracker.manifest('/example/second');
			tracker.update('manifest', { status: 'completed' });
			tracker.update('audit', { status: 'skipped' });
			tracker.update('outdated', { status: 'completed' });
			tracker.update('tree', { status: 'skipped' });
			tracker.update('crates', { status: 'running', total: 10, completed: 5, active: ['https://example.invalid/versions'] });
			tooltip = buildAnalysisStatus(latest).tooltip.value;
			assert.ok(tooltip.includes('`[==========----------]` **50%**'));
			assert.strictEqual((tooltip.match(/\*\*\d+%\*\*/g) ?? []).length, 1);
			assert.ok(tooltip.includes('- $(check) Reading manifest - completed'));
			assert.ok(tooltip.includes('- $(dash) Checking security advisories - skipped'));
			assert.ok(tooltip.includes('- $(check) Checking dependency updates - completed'));
			assert.ok(tooltip.includes('- $(dash) Tracing affected dependencies - skipped'));
			assert.ok(tooltip.includes('- $(sync~spin) Loading published versions (5/10) - running'));
			assert.ok(!tooltip.includes('https://example.invalid'));

			tracker.update('crates', { status: 'failed' });
			assert.ok(buildAnalysisStatus(latest).tooltip.value.includes('- $(warning) Loading published versions (5/10) - failed'));
			tracker.update('crates', { status: 'completed', completed: 10 });
			tracker.manifestCompleted();
			tracker.finish();
			tooltip = buildAnalysisStatus(latest).tooltip.value;
			assert.ok(tooltip.includes('2/2 manifests processed'));
			assert.ok(tooltip.includes('`[====================]` **100%**'));
			assert.ok(!tooltip.includes('Current manifest'));
			assert.ok(!tooltip.includes('Loading published versions'));
			assert.ok(tooltip.includes('Duration:'));

			tracker.begin(2);
			tracker.manifest('/example/broken');
			tracker.finish('Analysis interrupted');
			tooltip = buildAnalysisStatus(latest).tooltip.value;
			assert.ok(tooltip.includes('Analysis failed'));
			assert.ok(tooltip.includes('0/2 manifests processed'));
			assert.ok(tooltip.includes('1 analysis error'));
			assert.ok(tooltip.includes('command:cargo-deps.showOutput'));
			assert.ok(!tooltip.includes('**100%**'));
		} finally {
			subscription.dispose();
			tracker.dispose();
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

	test('limits HTTP concurrency and drains queued requests after failures without duplicating lookups', async () => {
		const originalFetch = globalThis.fetch;
		const responses = deferred<void>();
		let active = 0;
		let peak = 0;
		let calls = 0;
		globalThis.fetch = async input => {
			calls++;
			active++;
			peak = Math.max(peak, active);
			try {
				await responses.promise;
				if (String(input).endsWith('/crate-0')) {
					return new Response('Service unavailable', { status: 503 });
				}
				return Response.json(String(input).includes('/versions')
					? { versions: [] } : { crate: { max_version: '1.0.0' } });
			} finally {
				active--;
			}
		};
		const service = new CratesIoService();
		const lookups = Array.from({ length: 5 }, (_, index) => service.getReleaseInfo(`crate-${index}`));
		const sharedEvents: CratesIoProgress[] = [];
		const shared = service.getReleaseInfo('crate-4', event => sharedEvents.push(event));
		const results = Promise.allSettled([...lookups, shared]);
		try {
			await Promise.resolve();
			assert.strictEqual(calls, 6);
			assert.deepStrictEqual(sharedEvents, [{ kind: 'shared' }]);
			responses.resolve();
			const settled = await results;
			assert.strictEqual(calls, 10);
			assert.strictEqual(peak, 6);
			assert.strictEqual(active, 0);
			assert.strictEqual(settled.filter(result => result.status === 'rejected').length, 1);
			assert.strictEqual(settled[5].status, 'fulfilled');
		} finally {
			responses.resolve();
			await results;
			globalThis.fetch = originalFetch;
		}
	});

	test('cancels active and queued HTTP requests and never shares an aborted lookup with its replacement', async () => {
		const originalFetch = globalThis.fetch;
		const first = new AbortController();
		const replacement = new AbortController();
		const replacementStarted = deferred<void>();
		const replacementResponses = deferred<void>();
		const events: CratesIoProgress[] = [];
		let calls = 0;
		let replacementCalls = 0;
		globalThis.fetch = async (input, options) => {
			calls++;
			const signal = options?.signal;
			assert.ok(signal);
			if (!first.signal.aborted) {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				});
			} else {
				replacementCalls++;
				if (replacementCalls === 2) {
					replacementStarted.resolve();
				}
				await replacementResponses.promise;
			}
			return Response.json(String(input).includes('/versions')
				? { versions: [] } : { crate: { max_version: '3.0.0' } });
		};
		const service = new CratesIoService();
		const oldLookups = Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
			service.getReleaseInfo(`crate-${index}`, event => events.push(event), first.signal)));
		let fresh: Promise<unknown> | undefined;
		try {
			await Promise.resolve();
			assert.strictEqual(calls, 6);
			first.abort();
			fresh = service.getReleaseInfo('crate-0', undefined, replacement.signal);
			await replacementStarted.promise;
			const oldResults = await oldLookups;
			assert.ok(oldResults.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
			assert.strictEqual(calls, 8, 'Cancelled queue entries must not send HTTP requests');
			assert.ok(!events.some(event => event.kind === 'request' && event.status === 'failed'));
			const sharedEvents: CratesIoProgress[] = [];
			const shared = service.getReleaseInfo('crate-0', event => sharedEvents.push(event), replacement.signal);
			assert.deepStrictEqual(sharedEvents, [{ kind: 'shared' }], 'Old cleanup must not remove the replacement lookup');
			replacementResponses.resolve();
			await Promise.all([fresh, shared]);
			assert.strictEqual((await service.getReleaseInfo('crate-0')).latestVersion, '3.0.0');
			assert.strictEqual(calls, 8);
		} finally {
			first.abort();
			replacementResponses.resolve();
			await oldLookups;
			await fresh;
			globalThis.fetch = originalFetch;
		}
	});

	test('starts replacement scans immediately and ignores late Cargo results from repeated cancellations', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-restart-'));
		const first = new AbortController();
		const second = new AbortController();
		const third = new AbortController();
		const started = [deferred<void>(), deferred<void>()];
		const commands = [deferred<[]>(), deferred<[]>()];
		const signals: Array<AbortSignal | undefined> = [];
		let calls = 0;
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { return []; }
			override async outdated(_root: string, _workspace: boolean, signal?: AbortSignal) {
				const index = calls++;
				signals.push(signal);
				if (index < commands.length) {
					started[index].resolve();
					return commands[index].promise;
				}
				return [];
			}
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion: '3.0.0', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const progress: AnalysisProgress[] = [];
		const subscription = analysis.onDidProgress(event => progress.push(event));
		const operations: Promise<unknown>[] = [];
		try {
			await writeFile(path.join(root, 'Cargo.toml'), '[dependencies]\nserde = "1.0"');
			operations.push(analysis.refreshAll([root], first.signal).catch(error => error));
			await started[0].promise;
			first.abort();
			operations.push(analysis.refreshAll([root], second.signal).catch(error => error));
			await started[1].promise;
			second.abort();
			await analysis.refreshAll([root], third.signal);
			assert.deepStrictEqual(signals, [first.signal, second.signal, third.signal]);
			assert.strictEqual(analysis.getSnapshot(root)?.dependencies[0].latestVersion, '3.0.0');
			const eventsAfterReplacement = progress.length;
			commands.forEach(command => command.resolve([]));
			const cancelled = await Promise.all(operations);
			assert.ok(cancelled.every(error => error instanceof Error && error.name === 'AbortError'));
			assert.strictEqual(progress.length, eventsAfterReplacement, 'Late completions must not update replacement progress');
			assert.deepStrictEqual(progress[progress.length - 1].errors, []);
			assert.strictEqual(progress[progress.length - 1].status, 'completed');
			assert.strictEqual(analysis.getSnapshot(root)?.dependencies[0].latestVersion, '3.0.0');
		} finally {
			first.abort();
			second.abort();
			third.abort();
			commands.forEach(command => command.resolve([]));
			await Promise.all(operations);
			subscription.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('restores previous snapshots and removes partial results when a scan is cancelled', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-rollback-'));
		const member = path.join(root, 'member');
		const pending = path.join(root, 'pending');
		const controller = new AbortController();
		const blocked = deferred<void>();
		const release = deferred<void>();
		let latestVersion = '1.0.0';
		class TestCargoService extends CargoService {
			override async workspaceRoot(manifestRoot: string) {
				if (manifestRoot === pending) {
					blocked.resolve();
					await release.promise;
				}
				return root;
			}
			override async audit() { return []; }
			override async outdated() { return []; }
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion, versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		const published: Array<{ root: string; contents: string }> = [];
		const subscription = analysis.onDidAnalyze(snapshot => published.push(snapshot));
		let operation: Promise<unknown> | undefined;
		try {
			await mkdir(member);
			await mkdir(pending);
			for (const manifestRoot of [root, member, pending]) {
				await writeFile(path.join(manifestRoot, 'Cargo.toml'), '[dependencies]\nserde = "1.0"');
			}
			await analysis.refreshAll([root]);
			const previous = analysis.getSnapshot(root);
			latestVersion = '2.0.0';
			operation = analysis.refreshAll([root, member, pending], controller.signal).catch(error => error);
			await blocked.promise;
			assert.strictEqual(analysis.getSnapshot(root)?.dependencies[0].latestVersion, '2.0.0');
			assert.ok(analysis.getSnapshot(member));
			controller.abort();
			assert.strictEqual(analysis.getSnapshot(root), previous);
			assert.strictEqual(analysis.getSnapshot(member), undefined);
			assert.deepStrictEqual(published.slice(-2).map(snapshot => [snapshot.root, snapshot.contents]), [
				[root, previous!.contents], [member, ''],
			]);
			latestVersion = '3.0.0';
			await analysis.refreshAll([root, member], new AbortController().signal);
			release.resolve();
			const error = await operation;
			assert.ok(error instanceof Error);
			assert.strictEqual(error.name, 'AbortError');
			assert.strictEqual(analysis.getSnapshot(root)?.dependencies[0].latestVersion, '3.0.0');
			assert.strictEqual(analysis.getSnapshot(pending), undefined);
		} finally {
			controller.abort();
			release.resolve();
			await operation;
			subscription.dispose();
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
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
			assert.strictEqual(analysis.getSnapshot(member)?.dependencies[0].auditAvailable, false);
			fail = false;
			await analysis.refreshAll([root, member]);
			const success = events[events.length - 1];
			assert.deepStrictEqual(success.errors, []);
			assert.strictEqual(success.steps.find(step => step.id === 'audit')?.status, 'completed');
			assert.strictEqual(buildAnalysisStatus(success).text, '$(check) Cargo Deps');
			assert.strictEqual(analysis.getSnapshot(member)?.dependencies[0].auditAvailable, true);
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
			assert.strictEqual(analysis.getSnapshots().length, 2);
			assert.strictEqual(analysis.getSnapshot(member)?.packageName, 'member');
			assert.strictEqual(analysis.getSnapshot(member)?.workspaceRoot, root);
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

	test('shares resource metadata across workspace members and cached scans without extra HTTP requests', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-resources-'));
		const member = path.join(root, 'member');
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { return []; }
			override async outdated() { return []; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new CratesIoService());
		globalThis.fetch = async input => {
			const url = String(input);
			requests.push(url);
			return Response.json(url.includes('/versions') ? { versions: [] } : {
				crate: url.endsWith('/serde') ? {
					max_version: '1.2.0',
					documentation: 'https://docs.rs/serde/latest/serde/',
					repository: 'https://github.com/serde-rs/serde',
				} : { max_version: '1.2.0', documentation: null, repository: false },
			});
		};
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), [
				'[workspace]',
				'members = ["member"]',
				'[workspace.dependencies]',
				'transport = { package = "serde", version = "1.0" }',
				'plain = "1.0"',
			].join('\n'));
			await writeFile(path.join(member, 'Cargo.toml'), '[dependencies]\ntransport.workspace = true\nplain.workspace = true');
			for (let scan = 0; scan < 2; scan++) {
				await analysis.refreshAll([root, member]);
				for (const manifestRoot of [root, member]) {
					const dependencies = analysis.getSnapshot(manifestRoot)!.dependencies;
					const transport = dependencies.find(health => health.dependency.name === 'transport')!;
					assert.strictEqual(transport.dependency.packageName, 'serde');
					assert.strictEqual(transport.documentationUrl, 'https://docs.rs/serde/latest/serde/');
					assert.strictEqual(transport.repositoryUrl, 'https://github.com/serde-rs/serde');
					const plain = dependencies.find(health => health.dependency.name === 'plain')!;
					assert.strictEqual(plain.documentationUrl, undefined);
					assert.strictEqual(plain.repositoryUrl, undefined);
				}
				assert.strictEqual(requests.length, 4);
				assert.strictEqual(new Set(requests).size, 4);
				assert.ok(requests.every(url => /^https:\/\/crates.io\/api\/v1\/crates\/(serde|plain)(\/versions\?per_page=10)?$/.test(url)));
			}
		} finally {
			globalThis.fetch = originalFetch;
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('reuses workspace manifests and failed release lookups within a scan, then retries on the next scan', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-batch-cache-'));
		const member = path.join(root, 'member');
		const contents = [
			'[workspace.dependencies]',
			'public = "1.0"',
			'renamed = { package = "public", version = "1.0" }',
			'git = { git = "https://example.invalid/repo", version = "1.0" }',
			'private = { registry = "company", version = "1.0" }',
			'local = { path = "../local", version = "1.0" }',
		].join('\n');
		let changeWorkspace = true;
		let fail = true;
		const lookups: string[] = [];
		class TestCargoService extends CargoService {
			override async workspaceRoot(manifestRoot: string) {
				if (manifestRoot === member && changeWorkspace) {
					changeWorkspace = false;
					await writeFile(path.join(root, 'Cargo.toml'), contents.replaceAll('"1.0"', '"2.0"'));
				}
				return root;
			}
			override async audit() { return []; }
			override async outdated() { return []; }
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo(name: string) {
				lookups.push(name);
				if (fail) { throw new Error('Registry unavailable'); }
				return { latestVersion: '3.0.0', versions: [] };
			}
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), contents);
			await writeFile(path.join(member, 'Cargo.toml'), [
				'[dependencies]',
				'public.workspace = true',
				'git.workspace = true',
				'private.workspace = true',
				'[dependencies.local]',
				'workspace = true',
				'[dependencies.renamed]',
				'workspace = true',
			].join('\n'));
			await analysis.refreshAll([root, member]);
			assert.deepStrictEqual(lookups, ['public']);
			const dependencies = analysis.getSnapshot(member)!.dependencies.map(health => health.dependency);
			assert.ok(dependencies.every(dependency => dependency.versionRequirement === '1.0'));
			assert.strictEqual(dependencies.find(dependency => dependency.name === 'git')?.git, 'https://example.invalid/repo');
			assert.strictEqual(dependencies.find(dependency => dependency.name === 'private')?.registry, 'company');
			assert.strictEqual(dependencies.find(dependency => dependency.name === 'local')?.localPath, '../local');
			assert.strictEqual(dependencies.find(dependency => dependency.name === 'renamed')?.packageName, 'public');

			fail = false;
			await analysis.refreshAll([member, root]);
			assert.deepStrictEqual(lookups, ['public', 'public']);
			const health = analysis.getSnapshot(member)!.dependencies;
			assert.ok(health.every(item => item.dependency.versionRequirement === '2.0'));
			assert.ok(health.filter(item => ['git', 'private', 'local'].includes(item.dependency.name)).every(item => item.latestVersion === ''));
			assert.strictEqual(health.find(item => item.dependency.name === 'public')?.latestVersion, '3.0.0');
		} finally {
			analysis.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test('runs cargo outdated once per workspace and keeps member-specific results', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cargo-deps-outdated-'));
		const member = path.join(root, 'member');
		let outdatedCalls = 0;
		class TestCargoService extends CargoService {
			override async workspaceRoot() { return root; }
			override async audit() { return []; }
			override async outdated(workspaceRoot: string, workspace: boolean) {
				outdatedCalls++;
				assert.strictEqual(workspaceRoot, root);
				assert.strictEqual(workspace, true);
				return [
					{ crateName: 'application', name: 'serde', project: '1.0.0', latest: '1.1.0' },
					{ crateName: 'member', name: 'serde', project: '2.0.0', latest: '2.1.0' },
				];
			}
		}
		class TestCratesIoService extends CratesIoService {
			override async getReleaseInfo() { return { latestVersion: '9.0.0', versions: [] }; }
		}
		const analysis = new DependencyAnalysisService(new TestCargoService(), new TestCratesIoService());
		try {
			await mkdir(member);
			await writeFile(path.join(root, 'Cargo.toml'), [
				'[workspace]',
				'members = ["member"]',
				'resolver = "2"',
				'[package]',
				'name = "application"',
				'version = "0.1.0"',
				'[dependencies]',
				'serde = "1.0"',
			].join('\n'));
			await writeFile(path.join(member, 'Cargo.toml'), [
				'[package]',
				'name = "member"',
				'version = "0.1.0"',
				'[dependencies]',
				'serde = "2.0"',
			].join('\n'));

			await analysis.refreshAll([root, member]);

			assert.strictEqual(outdatedCalls, 1);
			assert.deepStrictEqual(
				analysis.getSnapshot(root)?.dependencies.map(health => [health.installedVersion, health.latestVersion]),
				[['1.0.0', '1.1.0']],
			);
			assert.deepStrictEqual(
				analysis.getSnapshot(member)?.dependencies.map(health => [health.installedVersion, health.latestVersion]),
				[['2.0.0', '2.1.0']],
			);
		} finally {
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
		const output = parseCargoJson([
			'{"crate_name":"demo_app","dependencies":[{"name":"serialport","project":"4.9.0","latest":"4.10.1"}]}',
			'{"crate_name":"driver_commons","dependencies":[{"name":"serialport","project":"4.9.0","latest":"4.10.1"}]}',
		].join('\n'));
		assert.deepStrictEqual(output, [
			{ crate_name: 'demo_app', dependencies: [{ name: 'serialport', project: '4.9.0', latest: '4.10.1' }] },
			{ crate_name: 'driver_commons', dependencies: [{ name: 'serialport', project: '4.9.0', latest: '4.10.1' }] },
		]);
		assert.deepStrictEqual(parseOutdatedReport(output), [
			{ crateName: 'demo_app', name: 'serialport', project: '4.9.0', latest: '4.10.1' },
			{ crateName: 'driver_commons', name: 'serialport', project: '4.9.0', latest: '4.10.1' },
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
		for (const command of ['cargo-deps.filterUpdates', 'cargo-deps.updateDependency', 'cargo-deps.updateVisible']) {
			assert.ok(commands.includes(command));
		}
		const contributedViews = extension.packageJSON.contributes.views['cargo-deps'] as { id: string }[];
		assert.deepStrictEqual(contributedViews.map(view => view.id), [
			'cargo-deps.dependencies', 'cargo-deps.updates', 'cargo-deps.security',
		]);
		for (const view of contributedViews) {
			await vscode.commands.executeCommand(`${view.id}.focus`);
		}
	});
});
