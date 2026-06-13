import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = new URL('../dist/flue.js', import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

let server;
let registryUrl;

function stripFrontmatter(source) {
	if (!source.startsWith('---\n')) return source;
	const end = source.indexOf('\n---\n', 4);
	if (end < 0) return source;
	return source.slice(end + '\n---\n'.length).replace(/^\n+/, '');
}

async function runCli(args) {
	const child = spawn(process.execPath, [cli.pathname, ...args], {
		env: { ...process.env, FLUE_REGISTRY_URL: registryUrl },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	const [code, signal] = await once(child, 'exit');
	return { code, signal, stdout, stderr };
}

before(async () => {
	server = createServer(async (request, response) => {
		const slug = /^\/([^/]+)\.md$/.exec(request.url ?? '')?.[1];
		const files = {
			channel: 'channel.md',
			github: 'channel--github.md',
			slack: 'channel--slack.md',
			discord: 'channel--discord.md',
			teams: 'channel--teams.md',
		};
		const file = slug ? files[slug] : undefined;
		if (!file) {
			response.writeHead(404).end('Not found');
			return;
		}
		const source = await readFile(join(repoRoot, 'connectors', file), 'utf8');
		response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
		response.end(stripFrontmatter(source));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	registryUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	server.close();
	await once(server, 'close');
});

describe('flue add', () => {
	it('lists named channel recipes and both generic categories when no name is given', async () => {
		const result = await runCli(['add']);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /flue add github\s+channel\s+https:\/\/github\.com/);
		assert.match(result.stderr, /flue add slack\s+channel\s+https:\/\/slack\.com/);
		assert.match(
			result.stderr,
			/flue add teams\s+channel\s+https:\/\/www\.microsoft\.com\/microsoft-teams/,
		);
		assert.ok(result.stderr.includes('flue add <url> --category sandbox'));
		assert.ok(result.stderr.includes('flue add <url> --category channel'));
	});

	it('prints the Teams channel recipe with the Workers-compatible Fetch path', async () => {
		const result = await runCli(['add', 'teams', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Microsoft Teams Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/teams/activities'));
		assert.ok(result.stdout.includes('https://api.botframework.com/.default'));
	});

	it('prints a named channel recipe without registry frontmatter', async () => {
		const result = await runCli(['add', 'slack', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Slack Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('@slack/web-api@^8.0.0-rc.1'));
		assert.ok(result.stdout.includes('/channels/slack/commands'));
		assert.ok(!result.stdout.startsWith('---'));
	});

	it('substitutes the provider research URL into the generic channel recipe', async () => {
		const url = 'https://docs.example.test/webhooks';
		const result = await runCli(['add', url, '--category', 'channel', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes(`\`${url}\``));
		assert.ok(!result.stdout.includes('{{URL}}'));
	});

	it('rejects an unknown category with both known categories in the guidance', async () => {
		const result = await runCli([
			'add',
			'https://docs.example.test',
			'--category',
			'unknown',
			'--print',
		]);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Known categories: channel, sandbox'));
	});
});
