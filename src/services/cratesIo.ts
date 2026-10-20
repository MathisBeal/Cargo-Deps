import type { CrateReleaseInfo, PublishedVersion } from '../types';

const CACHE_DURATION_MS = 10 * 60 * 1000;

interface CacheEntry {
	value: CrateReleaseInfo;
	expiresAt: number;
}

export class CratesIoService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly requests = new Map<string, Promise<CrateReleaseInfo>>();

	async getReleaseInfo(crateName: string): Promise<CrateReleaseInfo> {
		const cached = this.cache.get(crateName);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value;
		}

		const pending = this.requests.get(crateName);
		if (pending) {
			return pending;
		}

		const request = this.fetchReleaseInfo(crateName);
		this.requests.set(crateName, request);
		try {
			const value = await request;
			this.cache.set(crateName, { value, expiresAt: Date.now() + CACHE_DURATION_MS });
			return value;
		} finally {
			this.requests.delete(crateName);
		}
	}

	private async fetchReleaseInfo(crateName: string): Promise<CrateReleaseInfo> {
		const crateUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
		const [crateData, versionData] = await Promise.all([
			this.fetchJson(crateUrl) as Promise<{ crate?: { max_version?: unknown; max_stable_version?: unknown } }>,
			this.fetchJson(`${crateUrl}/versions?per_page=10`) as Promise<{ versions?: unknown }>,
		]);
		const data = versionData;
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

	private async fetchJson(url: string): Promise<unknown> {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'cargo-deps VS Code extension' },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			throw new Error(`crates.io returned HTTP ${response.status}`);
		}
		return response.json() as Promise<unknown>;
	}
}