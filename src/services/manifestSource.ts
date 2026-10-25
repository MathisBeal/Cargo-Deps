interface Token {
	text: string;
	start: number;
	end: number;
}

export interface DependencySource {
	line: number;
	versionRange?: { start: number; end: number };
}

export function sourceKey(path: string[]): string {
	return JSON.stringify(path);
}

// Tokenize before locating assignments so comments, quoted keys and nested values
// cannot be mistaken for an editable version.
export function dependencySources(
	contents: string,
	parse: (source: string) => Record<string, unknown>,
): Map<string, DependencySource> {
	const tokens: Token[] = [];
	const pattern = /#[^\r\n]*|"""(?:\\[\s\S]|"(?!"")|[^"\\])*"{3,5}|'''[\s\S]*?'{3,5}|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[ \t\r]+|\n|[.[\]{},=]|[^ \t\r\n.[\]{},=#]+/g;
	for (const match of contents.matchAll(pattern)) {
		if (!/^(?:#|[ \t\r])/.test(match[0])) {
			tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
		}
	}
	const assignments = new Map<string, { key: Token; value: Token[] }>();
	let section: string[] = [];
	let index = 0;
	const keyName = (token: Token): string => /^['"]/.test(token.text)
		? String(parse(`value = ${token.text}`).value)
		: token.text;
	const readPath = (): { path: string[]; key: Token } => {
		const key = tokens[index];
		const path = [keyName(tokens[index++])];
		while (tokens[index]?.text === '.') {
			index++;
			path.push(keyName(tokens[index++]));
		}
		return { path, key };
	};
	const record = (path: string[], key: Token, value: Token[]) => {
		assignments.set(sourceKey(path), { key, value });
		if (value[0]?.text !== '{') {
			return;
		}
		let cursor = 1;
		while (cursor < value.length - 1) {
			if ([',', '\n'].includes(value[cursor].text)) {
				cursor++;
				continue;
			}
			const childKey = value[cursor];
			const childPath = [keyName(value[cursor++])];
			while (value[cursor]?.text === '.') {
				cursor++;
				childPath.push(keyName(value[cursor++]));
			}
			cursor++; // equals
			const start = cursor;
			let depth = 0;
			while (cursor < value.length - 1) {
				const text = value[cursor].text;
				if (depth === 0 && text === ',') {
					break;
				}
				if (text === '{' || text === '[') { depth++; }
				if (text === '}' || text === ']') { depth--; }
				cursor++;
			}
			record([...path, ...childPath], childKey, value.slice(start, cursor));
		}
	};
	while (index < tokens.length) {
		if (tokens[index].text === '\n') {
			index++;
			continue;
		}
		if (tokens[index].text === '[') {
			index++;
			const arrayTable = tokens[index]?.text === '[';
			if (arrayTable) { index++; }
			section = readPath().path;
			index += arrayTable ? 2 : 1;
			continue;
		}
		const { path, key } = readPath();
		index++; // equals
		const start = index;
		let depth = 0;
		while (index < tokens.length) {
			const text = tokens[index].text;
			if (depth === 0 && text === '\n') {
				break;
			}
			if (text === '{' || text === '[') { depth++; }
			if (text === '}' || text === ']') { depth--; }
			index++;
		}
		record([...section, ...path], key, tokens.slice(start, index));
	}
	const sources = new Map<string, DependencySource>();
	for (const [key, assignment] of assignments) {
		const path = JSON.parse(key) as string[];
		const isVersion = path.at(-1) === 'version';
		const dependencyPath = isVersion ? path.slice(0, -1) : path;
		const value = assignment.value.filter(token => token.text !== '\n');
		const token = value[0];
		if (token && /^(['"])(?!\1\1)/.test(token.text) && value.length === 1) {
			const source: DependencySource = {
				line: contents.slice(0, assignment.key.start).split('\n').length - 1,
				versionRange: { start: token.start + 1, end: token.end - 1 },
			};
			sources.set(sourceKey(dependencyPath), source);
		}
	}
	return sources;
}
