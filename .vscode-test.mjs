import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'extension',
		files: 'out/test/extension.test.js',
	},
	{
		label: 'updates',
		files: 'out/test/updates.test.js',
	},
]);
