import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(left, right) {
	for (let index = 0; index < 3; index++) {
		const difference = BigInt(left.split('.')[index]) - BigInt(right.split('.')[index]);
		if (difference !== 0n) {
			return difference > 0n ? 1 : -1;
		}
	}
	return 0;
}

export function releaseMetadata(manifest, changelog, tags = [], requireNewVersion = false) {
	const { version, name } = manifest;
	if (typeof version !== 'string' || !versionPattern.test(version)) {
		throw new Error('package.json version must be a stable version: major.minor.patch.');
	}
	if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		throw new Error('package.json name must be a valid extension name.');
	}
	const sections = [...changelog.replace(/\r\n/g, '\n').matchAll(/^## (.+?)\s*$/gm)];
	const versioned = sections.filter(section => section[1] !== 'Unreleased');
	if (versioned[0]?.[1] !== version) {
		throw new Error(`The first versioned CHANGELOG.md section must be "## ${version}".`);
	}
	if (versioned.filter(section => section[1] === version).length !== 1) {
		throw new Error(`CHANGELOG.md must contain exactly one section for ${version}.`);
	}
	const section = versioned[0];
	const next = sections.find(candidate => candidate.index > section.index);
	const notes = changelog.replace(/\r\n/g, '\n')
		.slice(section.index + section[0].length, next?.index).trim();
	if (!notes) {
		throw new Error(`CHANGELOG.md section ${version} must not be empty.`);
	}
	const releasedVersions = tags
		.filter(tag => tag.startsWith('v') && versionPattern.test(tag.slice(1)))
		.map(tag => tag.slice(1))
		.sort(compareVersions);
	const latest = releasedVersions.at(-1);
	if (requireNewVersion && latest && compareVersions(version, latest) <= 0) {
		throw new Error(`Version ${version} must be newer than existing tag v${latest}. Bump package.json and CHANGELOG.md before merging into main.`);
	}
	if (requireNewVersion) {
		const unreleased = sections.find(candidate => candidate[1] === 'Unreleased');
		const following = unreleased && sections.find(candidate => candidate.index > unreleased.index);
		if (unreleased && changelog.replace(/\r\n/g, '\n').slice(unreleased.index + unreleased[0].length, following?.index).trim()) {
			throw new Error('Move all Unreleased notes into the new versioned section before merging into main.');
		}
	}
	return {
		version,
		tag: `v${version}`,
		vsix: `${name}-${version}.vsix`,
		notes,
		previousTag: latest ? `v${latest}` : undefined,
	};
}

export function releaseNotes(metadata, repository, commit, date = new Date()) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) {
		throw new Error('A GitHub owner/repository and full commit SHA are required.');
	}
	const url = `https://github.com/${repository}`;
	const comparison = metadata.previousTag
		? `${url}/compare/${metadata.previousTag}...${metadata.tag}`
		: `${url}/commits/${commit}`;
	return `# ${metadata.tag} - ${date.toISOString().slice(0, 10)} (UTC)\n\n${metadata.notes}\n\n---\n\n**Full changelog / diff:** ${comparison}\n\n**Commit:** [${commit.slice(0, 7)}](${url}/commit/${commit})\n\nDownload \`${metadata.vsix}\` below to install the extension or upload it to the Visual Studio Marketplace.\n`;
}

function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!['check', 'prepare'].includes(command) || args.some(arg => arg !== '--new-version')) {
		throw new Error('Usage: node scripts/release.mjs <check|prepare> [--new-version]');
	}
	const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
	const changelog = readFileSync('CHANGELOG.md', 'utf8');
	const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
	const metadata = releaseMetadata(manifest, changelog, tags, command === 'prepare' || args.includes('--new-version'));
	if (command === 'prepare') {
		writeFileSync('release-notes.md', releaseNotes(metadata, process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA));
	}
	console.log(`Validated ${metadata.tag}: ${metadata.vsix}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
