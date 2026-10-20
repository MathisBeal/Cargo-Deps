import * as assert from 'assert';
import { isOutdated } from '../providers/hintsProvider';
import { parseAuditReport } from '../services/cargo';
import { parseDependencies } from '../services/manifest';

suite('Extension Test Suite', () => {
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
});
