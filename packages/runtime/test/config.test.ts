import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../cli/src/lib/config.ts';

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
	});

	it('resolves relative paths from the config directory', async () => {
		const root = createFixtureRoot();
		writeConfig(root, `export default { target: 'node', root: './app', output: './build' };\n`);

		const { flueConfig } = await resolveConfig({ cwd: root });

		expect(flueConfig.root).toBe(path.join(root, 'app'));
		expect(flueConfig.output).toBe(path.join(root, 'build'));
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
