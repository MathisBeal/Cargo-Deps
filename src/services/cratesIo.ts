import type { CrateReleaseInfo, PublishedVersion } from '../types';
import type { CratesIoProgress } from './progress';

const CACHE_DURATION_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 6;

interface CacheEntry {
	value: CrateReleaseInfo;
	expiresAt: number;
}

export class CratesIoService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly requests = new Map<string, { promise: Promise<CrateReleaseInfo>; signal?: AbortSignal }>();
	private activeRequests = 0;
	private readonly waitingRequests: Array<() => void> = [];

	async getReleaseInfo(crateName: string, report?: (event: CratesIoProgress) => void, signal?: AbortSignal): Promise<CrateReleaseInfo> {
		signal?.throwIfAborted();
		const cached = this.cache.get(crateName);
		if (cached && cached.expiresAt > Date.now()) {
			report?.({ kind: 'cache' });
			return cached.value;
		}

		const pending = this.requests.get(crateName);
		if (pending && pending.signal === signal) {
			report?.({ kind: 'shared' });
			return pending.promise;
		}

		report?.({ kind: 'fetch', total: 2 });
		const request = { promise: this.fetchReleaseInfo(crateName, report, signal), signal };
		this.requests.set(crateName, request);
		try {
			const value = await request.promise;
			signal?.throwIfAborted();
			this.cache.set(crateName, { value, expiresAt: Date.now() + CACHE_DURATION_MS });
			return value;
		} finally {
			if (this.requests.get(crateName) === request) {
				this.requests.delete(crateName);
			}
		}
	}

	private async fetchReleaseInfo(crateName: string, report?: (event: CratesIoProgress) => void, signal?: AbortSignal): Promise<CrateReleaseInfo> {
		const crateUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
		const results = await Promise.allSettled([
			this.fetchJson(crateUrl, report, signal),
			this.fetchJson(`${crateUrl}/versions?per_page=10`, report, signal),
		]);
		signal?.throwIfAborted();
		const [crateResult, versionResult] = results;
		if (crateResult.status === 'rejected') {
			throw crateResult.reason;
		}
		if (versionResult.status === 'rejected') {
			throw versionResult.reason;
		}
		const crateData = crateResult.value as {
			crate?: { max_version?: unknown; max_stable_version?: unknown; documentation?: unknown; repository?: unknown };
		};
		const data = versionResult.value as { versions?: unknown };
		const versions = Array.isArray(data.versions)
			? data.versions.flatMap(value => {
				if (!value || typeof value !== 'object') {
					return [];
				}
				const version = value as Record<string, unknown>;
				if (typeof version.num !== 'string') {
					return [];
				}
				return [{
					number: version.num,
					createdAt: typeof version.created_at === 'string' ? version.created_at : '',
					yanked: version.yanked === true,
				} satisfies PublishedVersion];
			})
			: [];
		versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
		return {
			latestVersion: typeof crateData.crate?.max_version === 'string'
				? crateData.crate.max_version
				: typeof crateData.crate?.max_stable_version === 'string'
					? crateData.crate.max_stable_version
					: versions.find(version => !version.yanked)?.number ?? versions[0]?.number ?? '',
			versions,
			latestStableVersion: typeof crateData.crate?.max_stable_version === 'string' ? crateData.crate.max_stable_version : undefined,
			documentationUrl: typeof crateData.crate?.documentation === 'string' ? crateData.crate.documentation : undefined,
			repositoryUrl: typeof crateData.crate?.repository === 'string' ? crateData.crate.repository : undefined,
		};
	}

	private async acquireRequest(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
			await new Promise<void>((resolve, reject) => {
				const ready = () => {
					signal?.removeEventListener('abort', abort);
					resolve();
				};
				const abort = () => {
					const index = this.waitingRequests.indexOf(ready);
					if (index >= 0) {
						this.waitingRequests.splice(index, 1);
					}
					reject(signal?.reason);
				};
				this.waitingRequests.push(ready);
				signal?.addEventListener('abort', abort, { once: true });
			});
		} else {
			this.activeRequests++;
		}
	}

	private async fetchJson(url: string, report?: (event: CratesIoProgress) => void, signal?: AbortSignal): Promise<unknown> {
		await this.acquireRequest(signal);
		try {
			signal?.throwIfAborted();
			report?.({ kind: 'request', url, status: 'running' });
			const response = await fetch(url, {
				headers: { 'User-Agent': 'cargo-deps VS Code extension' },
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`crates.io returned HTTP ${response.status}${body ? `\n${body}` : ''}`);
			}
			const data: unknown = await response.json();
			signal?.throwIfAborted();
			report?.({ kind: 'request', url, status: 'completed' });
			return data;
		} catch (error) {
			signal?.throwIfAborted();
			report?.({ kind: 'request', url, status: 'failed' });
			const message = error instanceof Error ? error.message : String(error);
			const cause = error instanceof Error && error.cause instanceof Error ? `\nCaused by: ${error.cause.message}` : '';
			throw new Error(`GET ${url}: ${message}${cause}`, { cause: error });
		} finally {
			const next = this.waitingRequests.shift();
			if (next) {
				next();
			} else {
				this.activeRequests--;
			}
		}
	}
}