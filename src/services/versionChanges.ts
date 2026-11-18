import { prerelease, rcompare, satisfies, valid, validRange } from 'semver';
import type { DependencyHealth } from '../types';

export type UpdatePolicy = 'stable' | 'compatible' | 'prereleases';
export type VersionChange = 'compatible' | 'outside range' | 'prerelease' | 'unknown compatibility';

export function versionChange(health: DependencyHealth): VersionChange {
	const version = valid(health.latestVersion);
	if (!version) {
		return 'unknown compatibility';
	}
	if (prerelease(version)) {
		return 'prerelease';
	}
	const parts = health.dependency.versionRequirement.split(',').map(part => part.trim());
	if (!parts.every(part => /^(?:[=~^]|>=?|<=?)?\s*(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(part))) {
		return 'unknown compatibility';
	}
	const range = parts.map(part => {
		const requirement = part.trim();
		// Cargo's bare versions are caret requirements, not npm exact versions.
		return /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(requirement) ? `^${requirement}` : requirement;
	}).join(' ');
	if (!validRange(range)) {
		return 'unknown compatibility';
	}
	return satisfies(version, range) ? 'compatible' : 'outside range';
}

export function releaseForPolicy(health: DependencyHealth, policy: UpdatePolicy): DependencyHealth {
	const stable = health.latestStableVersion
		|| (valid(health.latestVersion) && !prerelease(health.latestVersion) ? health.latestVersion : '')
		|| health.versions.filter(version => !version.yanked && valid(version.number) && !prerelease(version.number))
			.map(version => version.number).sort(rcompare)[0] || '';
	const candidates = [stable, health.latestVersion, health.latestPublishedVersion ?? '', ...health.versions.map(version => version.number)]
		.filter(version => valid(version) && !health.versions.some(release => release.number === version && release.yanked));
	const latestVersion = policy === 'stable' ? stable : candidates
		.filter(version => policy === 'prereleases' || versionChange({ ...health, latestVersion: version }) === 'compatible')
		.sort(rcompare)[0] ?? '';
	return latestVersion === health.latestVersion ? health : { ...health, latestVersion };
}
