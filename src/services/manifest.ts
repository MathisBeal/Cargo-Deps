import type { Dependency } from '../types';

const DEPENDENCY_TABLES = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

export async function parseDependencies(contents: string): Promise<Dependency[]> {
	const { parse } = await import('smol-toml');
	const parsed = parse(contents) as Record<string, unknown>;
	const locations = findDependencyLocations(contents);
	const dependencies: Dependency[] = [];

	const visit = (value: unknown, path: string[]) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return;
		}

		const table = value as Record<string, unknown>;
		const parent = path[path.length - 2];
		if (path.length > 1 && DEPENDENCY_TABLES.has(parent)) {
			const name = path[path.length - 1];
			const line = locations.get(`table:${path.join('.')}`)?.shift() ?? locations.get(`*:${name}`)?.shift() ?? 0;
			dependencies.push({
				name,
				packageName: typeof table.package === 'string' ? table.package : name,
				versionRequirement: typeof table.version === 'string' ? table.version : '*',
				line,
			});
			return;
		}

		if (path.length > 0 && DEPENDENCY_TABLES.has(path[path.length - 1])) {
			for (const [name, specification] of Object.entries(table)) {
				if (name === 'workspace') {
					continue;
				}

				const details = typeof specification === 'string'
					? { version: specification }
					: specification && typeof specification === 'object' && !Array.isArray(specification)
						? specification as Record<string, unknown>
						: undefined;
				if (!details) {
					continue;
				}

				const packageName = typeof details.package === 'string' ? details.package : name;
				const section = path.join('.');
				const line = locations.get(`${section}:${name}`)?.shift() ?? locations.get(`*:${name}`)?.shift() ?? 0;
				dependencies.push({
					name,
					packageName,
					versionRequirement: typeof details.version === 'string' ? details.version : '*',
					line,
				});
			}
			return;
		}

		for (const [key, child] of Object.entries(table)) {
			visit(child, [...path, key]);
		}
	};

	visit(parsed, []);
	return dependencies;
}

function findDependencyLocations(contents: string): Map<string, number[]> {
	const locations = new Map<string, number[]>();
	let section = '';

	for (const [line, original] of contents.split(/\r?\n/).entries()) {
		const trimmed = original.trim();
		const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
		if (sectionMatch) {
			section = sectionMatch[1].replace(/['"]([^'"]+)['"]/g, '$1');
			const parts = section.split('.');
			if (parts.length > 1 && DEPENDENCY_TABLES.has(parts[parts.length - 2])) {
				locations.set(`table:${section}`, [line]);
				locations.set(`${parts.slice(0, -1).join('.')}:${parts[parts.length - 1]}`, [line]);
				locations.set(`*:${parts[parts.length - 1]}`, [line]);
			}
			continue;
		}
		const parts = section.split('.');
		if (parts.length > 1 && DEPENDENCY_TABLES.has(parts[parts.length - 2])) {
			const versionField = /^\s*version\s*=/.test(original);
			if (versionField) {
				locations.set(`${parts.slice(0, -1).join('.')}:${parts[parts.length - 1]}`, [line]);
				locations.set(`*:${parts[parts.length - 1]}`, [line]);
			}
			continue;
		}
		if (!DEPENDENCY_TABLES.has(section.split('.').at(-1) ?? '')) {
			continue;
		}

		const assignment = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/.exec(original);
		if (!assignment) {
			continue;
		}

		const name = assignment[1] ?? assignment[2] ?? assignment[3];
		const key = `${section}:${name}`;
		const entries = locations.get(key) ?? [];
		entries.push(line);
		locations.set(key, entries);
		const anySectionEntries = locations.get(`*:${name}`) ?? [];
		anySectionEntries.push(line);
		locations.set(`*:${name}`, anySectionEntries);
	}

	return locations;
}