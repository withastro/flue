import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, resolveConfigPath } from '../../cli/src/lib/config.ts';

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('authored config paths', () => {
	it.each(['root', 'output'] as const)('rejects an empty `%s` path', async (field) => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node', ${field}: '' };\n`);

		await expect(resolveConfig({ cwd: root })).rejects.toThrow(
			new RegExp(`Invalid config[\\s\\S]*${field}: Path must not be empty\\.`),
		);
	});

	it('preserves defaults when paths are omitted', async () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node' };\n`);

		const { flueConfig } = await resolveConfig({ cwd: root });

		expect(flueConfig.root).toBe(root);
		expect(flueConfig.output).toBe(path.join(root, 'dist'));
		expect(flueConfig.providers).toEqual([]);
	});

	it('resolves built-in provider allowlists', async () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node', providers: ['anthropic', 'openai'] };\n`);

		const { flueConfig } = await resolveConfig({ cwd: root });

		expect(flueConfig.providers).toEqual(['anthropic', 'openai']);
	});

	it('rejects unsupported built-in providers', async () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node', providers: ['unsupported'] };\n`);

		await expect(resolveConfig({ cwd: root })).rejects.toThrow(/Invalid config[\s\S]*providers\.0:/);
	});

	it('resolves relative paths from the config directory', async () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node', root: './app', output: './build' };\n`);

		const { flueConfig } = await resolveConfig({ cwd: root });

		expect(flueConfig.root).toBe(path.join(root, 'app'));
		expect(flueConfig.output).toBe(path.join(root, 'build'));
	});
});

describe('inline config paths', () => {
	it.each(['root', 'output'] as const)('rejects an empty `%s` path', async (field) => {
		const root = createFixtureRoot();

		await expect(
			resolveConfig({ cwd: root, inline: { target: 'node', [field]: '' } }),
		).rejects.toThrow(new RegExp(`Invalid config[\\s\\S]*${field}: Path must not be empty\\.`));
	});

	it('rejects an unsupported target', async () => {
		const root = createFixtureRoot();

		await expect(
			resolveConfig({ cwd: root, inline: { target: 'unsupported' as 'node' } }),
		).rejects.toThrow(/Invalid config[\s\S]*target:/);
	});

	it('resolves relative paths from a normalized caller cwd', async () => {
		const root = createFixtureRoot();
		const cwd = path.relative(process.cwd(), root);

		const { flueConfig } = await resolveConfig({
			cwd,
			configFile: false,
			inline: { target: 'node', root: './app', output: './build' },
		});

		expect(flueConfig.root).toBe(path.join(root, 'app'));
		expect(flueConfig.output).toBe(path.join(root, 'build'));
	});

	it('overrides config-file paths relative to the caller cwd', async () => {
		const root = createFixtureRoot();
		writeConfig(
			root,
			`export default { target: 'cloudflare', root: './file-app', output: './file-build' };\n`,
		);

		const { flueConfig } = await resolveConfig({
			cwd: root,
			inline: { target: 'node', root: './inline-app', output: './inline-build' },
		});

		expect(flueConfig).toMatchObject({
			target: 'node',
			root: path.join(root, 'inline-app'),
			output: path.join(root, 'inline-build'),
		});
	});
});

describe('config discovery paths', () => {
	it('returns an absolute path when cwd is relative', () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node' };\n`);

		expect(resolveConfigPath({ cwd: path.relative(process.cwd(), root) })).toBe(
			path.join(root, 'flue.config.mjs'),
		);
	});

	it('selects recognized config variants in priority order', () => {
		const root = createFixtureRoot();
		for (const basename of [
			'flue.config.cts',
			'flue.config.cjs',
			'flue.config.js',
			'flue.config.mjs',
			'flue.config.mts',
			'flue.config.ts',
		]) {
			fs.writeFileSync(path.join(root, basename), `export default { target: 'node' };\n`);
			expect(resolveConfigPath({ cwd: root })).toBe(path.join(root, basename));
		}
	});

	it('falls back after the selected config variant is deleted', () => {
		const root = createFixtureRoot();
		fs.writeFileSync(path.join(root, 'flue.config.ts'), `export default { target: 'node' };\n`);
		fs.writeFileSync(path.join(root, 'flue.config.mjs'), `export default { target: 'node' };\n`);

		expect(resolveConfigPath({ cwd: root })).toBe(path.join(root, 'flue.config.ts'));
		fs.rmSync(path.join(root, 'flue.config.ts'));
		expect(resolveConfigPath({ cwd: root })).toBe(path.join(root, 'flue.config.mjs'));
	});
});

function createFixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-config-'));
	fixtureRoots.push(root);
	return root;
}

function writeConfig(root: string, contents: string): void {
	fs.writeFileSync(path.join(root, 'flue.config.mjs'), contents);
}
