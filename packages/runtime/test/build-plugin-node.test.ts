import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext, BuildPlugin } from '../../cli/src/lib/types.ts';

describe('Node build plugin', () => {
	it('derives route metadata from imported agent and workflow modules', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain("import * as handler_triage_0 from '/tmp/triage.ts'");
		expect(entry).toContain('const normalized = normalizeBuiltModules(agentModules, workflowModules);');
		expect(entry).not.toContain('channelModules');
	});

	it('rejects duplicate agent basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-duplicate-agents-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), 'export async function init() {}\n');
		fs.writeFileSync(path.join(root, 'agents', 'assistant.js'), 'export async function init() {}\n');

		await expect(build({ root, target: 'node' })).rejects.toThrow('Duplicate agent basename "assistant"');
	});

	it('allows workflow exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-extra-exports-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'draft.ts'),
			`export interface DraftPayload { message: string }\n` +
				`export type DraftResult = { ok: boolean }\n` +
				`export const schema = { type: 'object' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export async function run() { return { ok: true }; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('allows agent exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-agent-extra-exports-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`export interface AssistantPayload { message: string }\n` +
				`export const metadata = { owner: 'test' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export async function init() { return { session() { throw new Error('not used'); } }; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('rejects legacy default-export agents with triggers using a migration message', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-legacy-agent-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'draft.ts'),
			`export const triggers = { webhook: true };\n` +
				`export default async function handler() { return 'ok'; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).rejects.toThrow('Found legacy 0.7 agent');
	});
});

const parserOnlyPlugin: BuildPlugin = {
	name: 'parser-only',
	bundle: 'none',
	entryFilename: 'server.mjs',
	generateEntryPoint() {
		return 'export default {};\n';
	},
};

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'triage', filePath: '/tmp/triage.ts', hasChannels: true, hasReceive: true, hasInit: true }],
		workflows: [],
		manifest: {
			agents: [{ name: 'triage', channels: {}, receive: true, init: true }],
			workflows: [],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'node' },
	};
}
