import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, releaseMetadata, releaseNotes } from './release.mjs';

const manifest = { name: 'cargo-deps', version: '0.2.0' };
const changelog = '# Changelog\n\n## Unreleased\n\n## 0.2.0\n\n### Added\n\n- New feature.\n\n## 0.1.0\n\n- Old feature.\n';

test('extracts only the matching version, preserving Markdown and accepting CRLF', () => {
	for (const text of [changelog, changelog.replace(/\n/g, '\r\n')]) {
		assert.deepEqual(releaseMetadata(manifest, text, ['v0.1.0'], true), {
			version: '0.2.0',
			tag: 'v0.2.0',
			vsix: 'cargo-deps-0.2.0.vsix',
			notes: '### Added\n\n- New feature.',
			previousTag: 'v0.1.0',
		});
	}
});

test('requires a stable version and a safe extension name', () => {
	for (const version of ['01.2.0', '0.2', 'v0.2.0', '0.2.0-beta.1', undefined]) {
		assert.throws(() => releaseMetadata({ ...manifest, version }, changelog), /stable version/);
	}
	assert.throws(() => releaseMetadata({ ...manifest, name: '../bad' }, changelog), /extension name/);
});

test('rejects missing, out-of-order, duplicate and empty changelog sections', () => {
	for (const text of [
		'# Changelog\n\n## Unreleased\n\n- New feature.',
		'## 0.3.0\n\n- Future.\n\n' + changelog,
		changelog + '\n## 0.2.0\n\n- Duplicate.',
		changelog.replace('### Added\n\n- New feature.', ''),
	]) {
		assert.throws(() => releaseMetadata(manifest, text), /CHANGELOG.md/);
	}
});

test('compares versions numerically, not lexically', () => {
	assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
	assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
	assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
	assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
	const metadata = releaseMetadata({ ...manifest, version: '0.10.0' }, '## 0.10.0\n\n- New.', ['v0.9.0', 'v0.8.0', 'unrelated'], true);
	assert.equal(metadata.previousTag, 'v0.9.0');
});

test('main requires a version strictly above all existing stable release tags', () => {
	for (const tags of [['v0.2.0'], ['v0.3.0'], ['v0.1.0', 'v1.0.0']]) {
		assert.throws(() => releaseMetadata(manifest, changelog, tags, true), /must be newer/);
	}
	assert.doesNotThrow(() => releaseMetadata(manifest, changelog, ['v0.2.0']));
	assert.doesNotThrow(() => releaseMetadata(manifest, changelog, [], true));
});

test('main rejects unreleased changes that would be omitted from the release', () => {
	const pending = changelog.replace('## Unreleased', '## Unreleased\n\n- Pending change.');
	assert.throws(() => releaseMetadata(manifest, pending, [], true), /Move all Unreleased notes/);
	assert.doesNotThrow(() => releaseMetadata(manifest, pending));
});

test('renders date, exact changelog notes, comparison, commit and VSIX filename', () => {
	const metadata = releaseMetadata(manifest, changelog, ['v0.1.0'], true);
	const commit = 'a'.repeat(40);
	const notes = releaseNotes(metadata, 'MathisBeal/Cargo-Deps', commit, new Date('2026-10-25T22:00:00Z'));
	assert.ok(notes.startsWith('# v0.2.0 - 2026-10-25 (UTC)\n'));
	assert.ok(notes.includes(metadata.notes));
	assert.ok(notes.includes('/compare/v0.1.0...v0.2.0'));
	assert.ok(notes.includes(`/commit/${commit}`));
	assert.ok(notes.includes('cargo-deps-0.2.0.vsix'));
	assert.ok(!notes.includes('Old feature'));
});

test('first release links commit history and invalid GitHub metadata fails explicitly', () => {
	const metadata = releaseMetadata(manifest, changelog, [], true);
	assert.ok(releaseNotes(metadata, 'MathisBeal/Cargo-Deps', 'b'.repeat(40)).includes(`/commits/${'b'.repeat(40)}`));
	assert.throws(() => releaseNotes(metadata, undefined, 'b'.repeat(40)), /GitHub/);
	assert.throws(() => releaseNotes(metadata, 'MathisBeal/Cargo-Deps', 'main'), /GitHub/);
});
