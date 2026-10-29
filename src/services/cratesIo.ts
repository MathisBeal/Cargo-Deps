import type { CrateReleaseInfo, PublishedVersion } from '../types';
import type { CratesIoProgress } from './progress';

const CACHE_DURATION_MS = 10 * 60 * 1000;

interface CacheEntry {
	value: CrateReleaseInfo;
	expiresAt: number;
}

export class CratesIoService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly requests = new Map<string, Promise<CrateReleaseInfo>>();

	async getReleaseInfo(crateName: string, report?: (event: CratesIoProgress) => void): Promise<CrateReleaseInfo> {
		const cached = this.cache.get(crateName);
		if (cached && cached.expiresAt > Date.now()) {
			report?.({ kind: 'cache' });
			return cached.value;
		}

		const pending = this.requests.get(crateName);
		if (pending) {
			report?.({ kind: 'shared' });
			return pending;
		}

		report?.({ kind: 'fetch', total: 2 });
		const request = this.fetchReleaseInfo(crateName, report);
		this.requests.set(crateName, request);
		try {
			const value = await request;
			this.cache.set(crateName, { value, expiresAt: Date.now() + CACHE_DURATION_MS });
			return value;
		} finally {
			this.requests.delete(crateName);
		}
	}

	private async fetchReleaseInfo(crateName: string, report?: (event: CratesIoProgress) => void): Promise<CrateReleaseInfo> {
		const crateUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
		const results = await Promise.allSettled([
			this.fetchJson(crateUrl, report),
			this.fetchJson(`${crateUrl}/versions?per_page=10`, report),
		]);
		const [crateResult, versionResult] = results;
		if (crateResult.status === 'rejected') {
			throw crateResult.reason;
		}
		if (versionResult.status === 'rejected') {
			throw versionResult.reason;
		}
		const crateData = crateResult.value as { crate?: { max_version?: unknown; max_stable_version?: unknown } };
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
		};
	}

	private async fetchJson(url: string, report?: (event: CratesIoProgress) => void): Promise<unknown> {
		report?.({ kind: 'request', url, status: 'running' });
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': 'cargo-deps VS Code extension' },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`crates.io returned HTTP ${response.status}${body ? `\n${body}` : ''}`);
			}
			const data: unknown = await response.json();
			report?.({ kind: 'request', url, status: 'completed' });
			return data;
		} catch (error) {
			report?.({ kind: 'request', url, status: 'failed' });
			const message = error instanceof Error ? error.message : String(error);
			const cause = error instanceof Error && error.cause instanceof Error ? `\nCaused by: ${error.cause.message}` : '';
			throw new Error(`GET ${url}: ${message}${cause}`, { cause: error });
		}
	}
}