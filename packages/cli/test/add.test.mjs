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
	const env = { ...process.env, FLUE_REGISTRY_URL: registryUrl };
	for (const key of Object.keys(env)) {
		if (key.startsWith('CODEX_')) delete env[key];
	}
	const child = spawn(process.execPath, [cli.pathname, ...args], {
		env,
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
			tooling: 'tooling.md',
			braintrust: 'tooling--braintrust.md',
			sentry: 'tooling--sentry.md',
			github: 'channel--github.md',
			stripe: 'channel--stripe.md',
			notion: 'channel--notion.md',
			resend: 'channel--resend.md',
			shopify: 'channel--shopify.md',
			intercom: 'channel--intercom.md',
			zendesk: 'channel--zendesk.md',
			'salesforce-marketing-cloud': 'channel--salesforce-marketing-cloud.md',
			slack: 'channel--slack.md',
			discord: 'channel--discord.md',
			teams: 'channel--teams.md',
			'google-chat': 'channel--google-chat.md',
			linear: 'channel--linear.md',
			telegram: 'channel--telegram.md',
			whatsapp: 'channel--whatsapp.md',
			twilio: 'channel--twilio.md',
			messenger: 'channel--messenger.md',
			daytona: 'sandbox--daytona.md',
			postgres: 'database--postgres.md',
			libsql: 'database--libsql.md',
			mongodb: 'database--mongodb.md',
			mysql: 'database--mysql.md',
			redis: 'database--redis.md',
			supabase: 'database--supabase.md',
			turso: 'database--turso.md',
			valkey: 'database--valkey.md',
		};
		const file = slug ? files[slug] : undefined;
		if (!file) {
			response.writeHead(404).end('Not found');
			return;
		}
		const source = await readFile(join(repoRoot, 'blueprints', file), 'utf8');
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
	it('lists named blueprints and every generic kind when no name is given', async () => {
		const result = await runCli(['add']);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /flue add channel github\s+channel\s+https:\/\/github\.com/);
		assert.match(result.stderr, /flue add channel stripe\s+channel\s+https:\/\/stripe\.com/);
		assert.match(
			result.stderr,
			/flue add channel notion\s+channel\s+https:\/\/developers\.notion\.com/,
		);
		assert.match(result.stderr, /flue add channel resend\s+channel\s+https:\/\/resend\.com/);
		assert.match(result.stderr, /flue add channel shopify\s+channel\s+https:\/\/shopify\.dev/);
		assert.match(
			result.stderr,
			/flue add channel intercom\s+channel\s+https:\/\/developers\.intercom\.com/,
		);
		assert.match(
			result.stderr,
			/flue add channel zendesk\s+channel\s+https:\/\/developer\.zendesk\.com/,
		);
		assert.match(
			result.stderr,
			/flue add channel salesforce-marketing-cloud\s+channel\s+https:\/\/developer\.salesforce\.com/,
		);
		assert.match(result.stderr, /flue add channel slack\s+channel\s+https:\/\/slack\.com/);
		assert.match(
			result.stderr,
			/flue add channel teams\s+channel\s+https:\/\/www\.microsoft\.com\/microsoft-teams/,
		);
		assert.match(
			result.stderr,
			/flue add channel google-chat\s+channel\s+https:\/\/developers\.google\.com\/workspace\/chat/,
		);
		assert.match(
			result.stderr,
			/flue add channel linear\s+channel\s+https:\/\/linear\.app\/developers/,
		);
		assert.match(
			result.stderr,
			/flue add channel telegram\s+channel\s+https:\/\/core\.telegram\.org\/bots\/api/,
		);
		assert.match(
			result.stderr,
			/flue add channel whatsapp\s+channel\s+https:\/\/developers\.facebook\.com\/docs\/whatsapp\/cloud-api/,
		);
		assert.match(
			result.stderr,
			/flue add channel twilio\s+channel\s+https:\/\/www\.twilio\.com\/docs\/messaging/,
		);
		assert.match(
			result.stderr,
			/flue add channel messenger\s+channel\s+https:\/\/developers\.facebook\.com\/docs\/messenger-platform/,
		);
		assert.match(
			result.stderr,
			/flue add database postgres\s+database\s+https:\/\/www\.postgresql\.org/,
		);
		assert.match(
			result.stderr,
			/flue add database libsql\s+database\s+https:\/\/github\.com\/tursodatabase\/libsql/,
		);
		assert.match(
			result.stderr,
			/flue add database mongodb\s+database\s+https:\/\/www\.mongodb\.com/,
		);
		assert.match(result.stderr, /flue add database mysql\s+database\s+https:\/\/www\.mysql\.com/);
		assert.match(result.stderr, /flue add database redis\s+database\s+https:\/\/redis\.io/);
		assert.match(result.stderr, /flue add database supabase\s+database\s+https:\/\/supabase\.com/);
		assert.match(result.stderr, /flue add database turso\s+database\s+https:\/\/turso\.tech/);
		assert.match(result.stderr, /flue add database valkey\s+database\s+https:\/\/valkey\.io/);
		assert.match(
			result.stderr,
			/flue add tooling braintrust\s+tooling\s+https:\/\/www\.braintrust\.dev/,
		);
		assert.match(result.stderr, /flue add tooling sentry\s+tooling\s+https:\/\/sentry\.io/);
		assert.ok(result.stderr.includes('flue add sandbox <url>'));
		assert.ok(result.stderr.includes('flue add channel <url>'));
		assert.ok(result.stderr.includes('flue add database <url>'));
		assert.ok(result.stderr.includes('flue add tooling <url>'));
	});

	it('prints sandbox blueprint paths under sandboxes when a provider is selected', async () => {
		const result = await runCli(['add', 'sandbox', 'daytona', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('<source-dir>/sandboxes/daytona.ts'));
		assert.ok(result.stdout.includes("'../sandboxes/daytona'"));
		assert.ok(!result.stdout.includes('/connectors/'));
	});

	it('prints the WhatsApp channel blueprint', async () => {
		const result = await runCli(['add', 'channel', 'whatsapp', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/whatsapp'));
		assert.ok(result.stdout.includes('@kapso/whatsapp-cloud-api@^0.2.1'));
		assert.ok(result.stdout.includes('/channels/whatsapp/webhook'));
		assert.ok(result.stdout.includes('X-Hub-Signature-256'));
	});

	it('prints the Stripe blueprint with snapshot and thin event support', async () => {
		const result = await runCli(['add', 'channel', 'stripe', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/stripe'));
		assert.ok(result.stdout.includes('stripe@^22.2.0'));
		assert.ok(result.stdout.includes('/channels/stripe/webhook'));
		assert.ok(result.stdout.includes('Stripe.createFetchHttpClient()'));
		assert.ok(result.stdout.includes("eventPayload: 'thin'"));
		assert.ok(result.stdout.includes('nodejs_compat'));
	});

	it('prints the Notion blueprint with setup and signed-event guidance', async () => {
		const result = await runCli(['add', 'channel', 'notion', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/notion'));
		assert.ok(result.stdout.includes('@notionhq/client@5.22.0'));
		assert.ok(result.stdout.includes('/channels/notion/webhook'));
		assert.ok(result.stdout.includes('verification_token'));
		assert.ok(result.stdout.includes('X-Notion-Signature'));
		assert.ok(result.stdout.includes('nodejs_compat'));
	});

	it('prints the Resend blueprint with signed ingress and fake-client guidance', async () => {
		const result = await runCli(['add', 'channel', 'resend', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/resend'));
		assert.ok(result.stdout.includes('resend@6.12.4'));
		assert.ok(result.stdout.includes('@types/node'));
		assert.ok(result.stdout.includes('@types/react'));
		assert.ok(result.stdout.includes('/channels/resend/webhook'));
		assert.ok(result.stdout.includes('svix-signature'));
		assert.ok(result.stdout.includes('delivery.id'));
		assert.ok(result.stdout.includes('nodejs_compat'));
		assert.ok(result.stdout.includes('fake transport'));
		assert.ok(result.stdout.includes('Never create a receiving domain'));
	});

	it('prints the Shopify blueprint with signed ingress and a shop-bound GraphQL client', async () => {
		const result = await runCli(['add', 'channel', 'shopify', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/shopify'));
		assert.ok(result.stdout.includes('@shopify/admin-api-client@1.1.2'));
		assert.ok(result.stdout.includes('@types/node'));
		assert.ok(result.stdout.includes('/channels/shopify/webhook'));
		assert.ok(result.stdout.includes('apiVersion: ADMIN_API_VERSION'));
		assert.ok(result.stdout.includes("'2026-04'"));
		assert.ok(result.stdout.includes('X-Shopify-Hmac-Sha256'));
		assert.ok(result.stdout.includes('previousClientSecret'));
		assert.ok(result.stdout.includes('customFetchApi'));
		assert.ok(result.stdout.includes('nodejs_compat'));
		assert.ok(result.stdout.includes('Never register a live webhook'));
	});

	it('prints the Intercom blueprint with endpoint validation and the official SDK', async () => {
		const result = await runCli(['add', 'channel', 'intercom', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/intercom'));
		assert.ok(result.stdout.includes('intercom-client@7.0.3'));
		assert.ok(result.stdout.includes('/channels/intercom/webhook'));
		assert.ok(result.stdout.includes('HEAD'));
		assert.ok(result.stdout.includes('X-Hub-Signature'));
		assert.ok(result.stdout.includes("version: '2.14'"));
		assert.ok(result.stdout.includes('nodejs_compat'));
		assert.ok(result.stdout.includes('Never register or modify a live webhook'));
	});

	it('prints the Zendesk blueprint with signed ingress and a ticket-bound Fetch client', async () => {
		const result = await runCli(['add', 'channel', 'zendesk', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/zendesk'));
		assert.ok(result.stdout.includes('lossless-json@4.3.0'));
		assert.ok(result.stdout.includes('/channels/zendesk/webhook'));
		assert.ok(result.stdout.includes('X-Zendesk-Webhook-Signature'));
		assert.ok(result.stdout.includes('X-Zendesk-Webhook-Signature-Timestamp'));
		assert.ok(result.stdout.includes('/api/v2/tickets/'));
		assert.ok(result.stdout.includes('nodejs_compat'));
		assert.ok(result.stdout.includes('Never create or modify a live webhook'));
	});

	it('prints the Salesforce Marketing Cloud blueprint with signed ENS batches', async () => {
		const result = await runCli(['add', 'channel', 'salesforce-marketing-cloud', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/salesforce-marketing-cloud'));
		assert.ok(result.stdout.includes('/channels/salesforce-marketing-cloud/events'));
		assert.ok(result.stdout.includes('x-sfmc-ens-signature'));
		assert.ok(result.stdout.includes('.rest.marketingcloudapis.com'));
		assert.ok(result.stdout.includes('/platform/v1/ens-callbacks/'));
		assert.ok(result.stdout.includes('nodejs_compat'));
		assert.ok(result.stdout.includes('Never register or modify a live callback'));
	});

	it('prints the Twilio blueprint with the Workers-compatible Fetch path', async () => {
		const result = await runCli(['add', 'channel', 'twilio', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/twilio'));
		assert.ok(result.stdout.includes('/channels/twilio/webhook'));
		assert.ok(result.stdout.includes('/channels/twilio/status'));
		assert.ok(result.stdout.includes('X-Twilio-Signature'));
		assert.ok(result.stdout.includes('application/x-www-form-urlencoded'));
		assert.ok(result.stdout.includes('Do not install the official `twilio` Node helper'));
	});

	it('prints the Messenger blueprint with verified batches and the Graph Fetch path', async () => {
		const result = await runCli(['add', 'channel', 'messenger', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@flue/messenger'));
		assert.ok(result.stdout.includes('/channels/messenger/webhook'));
		assert.ok(result.stdout.includes('X-Hub-Signature-256'));
		assert.ok(result.stdout.includes('EVENT_RECEIVED'));
		assert.ok(result.stdout.includes('entry.changes'));
		assert.ok(result.stdout.includes('Graph API Fetch client'));
	});

	it('prints the Teams channel blueprint with the Workers-compatible Fetch path', async () => {
		const result = await runCli(['add', 'channel', 'teams', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Microsoft Teams Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/teams/activities'));
		assert.ok(result.stdout.includes('https://api.botframework.com/.default'));
	});

	it('prints the Google Chat blueprint with both verified HTTP surfaces', async () => {
		const result = await runCli(['add', 'channel', 'google-chat', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Google Chat Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/google-chat/interactions'));
		assert.ok(result.stdout.includes('/channels/google-chat/events'));
		assert.ok(result.stdout.includes('https://www.googleapis.com/auth/chat.bot'));
	});

	it('prints the Linear blueprint with verified ingress and the official SDK path', async () => {
		const result = await runCli(['add', 'channel', 'linear', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Linear Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/linear/webhook'));
		assert.ok(result.stdout.includes('@linear/sdk@^86.0.0'));
		assert.ok(result.stdout.includes('nodejs_compat'));
	});

	it('prints the Telegram blueprint with verified ingress and the Workers client path', async () => {
		const result = await runCli(['add', 'channel', 'telegram', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Telegram Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/telegram/webhook'));
		assert.ok(result.stdout.includes('grammy@^1.43.0'));
		assert.ok(result.stdout.includes('nodejs_compat'));
	});

	it('prints provider-native payload guidance when the Slack blueprint is requested', async () => {
		const result = await runCli(['add', 'channel', 'slack', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Slack Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('@slack/web-api@^8.0.0-rc.1'));
		assert.ok(result.stdout.includes('async events({ payload })'));
		assert.ok(result.stdout.includes('switch (payload.event.type)'));
		assert.ok(result.stdout.includes('async commands({ c, payload })'));
		assert.ok(result.stdout.includes('/channels/slack/commands'));
		assert.ok(!result.stdout.includes('async events({ event })'));
		assert.ok(!result.stdout.includes('SLACK_APP_ID'));
		assert.ok(!result.stdout.includes('SLACK_TEAM_ID'));
		assert.ok(!result.stdout.startsWith('---'));
	});

	it('prints provider-native payload guidance when the Discord blueprint is requested', async () => {
		const result = await runCli(['add', 'channel', 'discord', '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.startsWith('# Add a Discord Channel to Flue'));
		assert.ok(result.stdout.includes('export const channel'));
		assert.ok(result.stdout.includes('export const client'));
		assert.ok(result.stdout.includes('/channels/discord/interactions'));
		assert.ok(result.stdout.includes('async interactions({ interaction })'));
		assert.ok(result.stdout.includes('interaction.type !== 2'));
		assert.ok(!result.stdout.includes('DISCORD_APPLICATION_ID'));
		assert.ok(!result.stdout.includes("interaction.type !== 'command'"));
		assert.ok(result.stdout.includes('Do not add Discord Gateway'));
		assert.ok(!result.stdout.startsWith('---'));
	});

	it('prints database blueprints with their transaction-safe runner wiring', async () => {
		const postgres = await runCli(['add', 'database', 'postgres', '--print']);
		assert.equal(postgres.code, 0);
		assert.ok(postgres.stdout.includes('@flue/postgres'));
		assert.ok(postgres.stdout.includes("import { Pool } from 'pg'"));
		assert.ok(postgres.stdout.includes('pool.connect()'));
		assert.ok(postgres.stdout.includes('BEGIN'));
		assert.ok(postgres.stdout.includes('ROLLBACK'));

		const libsql = await runCli(['add', 'database', 'libsql', '--print']);
		assert.equal(libsql.code, 0);
		assert.ok(libsql.stdout.includes('@flue/libsql'));
		assert.ok(libsql.stdout.includes('const serialize'));
		assert.ok(libsql.stdout.includes('tx.close()'));

		const mongodb = await runCli(['add', 'database', 'mongodb', '--print']);
		assert.equal(mongodb.code, 0);
		assert.ok(mongodb.stdout.includes('@flue/mongodb'));
		assert.ok(mongodb.stdout.includes("from 'mongodb'"));
		assert.ok(mongodb.stdout.includes('// flue-blueprint: database/mongodb@1'));
		assert.ok(mongodb.stdout.includes('MONGODB_URL'));
		assert.ok(mongodb.stdout.includes('MONGODB_DATABASE'));
		assert.ok(mongodb.stdout.includes('const queue'));
		assert.ok(mongodb.stdout.includes("readConcern: { level: 'snapshot' }"));
		assert.ok(mongodb.stdout.includes("writeConcern: { w: 'majority' }"));
		assert.ok(mongodb.stdout.includes("'TransientTransactionError'"));
		assert.ok(mongodb.stdout.includes("'UnknownTransactionCommitResult'"));
		assert.ok(mongodb.stdout.includes('commitAttempt < 10'));
		assert.ok(mongodb.stdout.includes("hello.msg === 'isdbgrid'"));
		assert.ok(mongodb.stdout.includes('db.createCollection'));
		assert.ok(mongodb.stdout.includes('db.collection(name).listIndexes()'));
		assert.ok(mongodb.stdout.includes('close: () => client.close()'));
		assert.ok(mongodb.stdout.includes('standalone `mongod` is unsupported'));
		assert.ok(mongodb.stdout.includes('This comparison is required when the marker is missing.'));
		assert.ok(mongodb.stdout.includes('### Version 1 — 2026-06-15\n\nInitial version.'));

		const mysql = await runCli(['add', 'database', 'mysql', '--print']);
		assert.equal(mysql.code, 0);
		assert.ok(mysql.stdout.includes('@flue/mysql'));
		assert.ok(mysql.stdout.includes('// flue-blueprint: database/mysql@1'));
		assert.ok(mysql.stdout.includes('pool.execute(text, params)'));
		assert.ok(mysql.stdout.includes('pool.getConnection()'));
		assert.ok(mysql.stdout.includes('connection.beginTransaction()'));
		assert.ok(mysql.stdout.includes('connection.commit()'));
		assert.ok(mysql.stdout.includes('connection.rollback()'));
		assert.ok(mysql.stdout.includes('connection.release()'));
		assert.ok(mysql.stdout.includes('result.map((row) => ({ ...row }))'));
		assert.ok(mysql.stdout.includes('Cloudflare target'));
		assert.ok(mysql.stdout.includes('This comparison is required when the marker is missing.'));
		assert.ok(mysql.stdout.includes('### Version 1 — 2026-06-14\n\nInitial version.'));

		const supabase = await runCli(['add', 'database', 'supabase', '--print']);
		assert.equal(supabase.code, 0);
		assert.ok(supabase.stdout.includes('@flue/postgres'));
		assert.ok(supabase.stdout.includes('// flue-blueprint: database/supabase@1'));
		assert.ok(supabase.stdout.includes('SUPABASE_DATABASE_URL'));
		assert.ok(supabase.stdout.includes("client.query('BEGIN')"));
		assert.ok(supabase.stdout.includes("client.query('COMMIT')"));
		assert.ok(supabase.stdout.includes("client.query('ROLLBACK')"));
		assert.ok(supabase.stdout.includes('pg_advisory_xact_lock'));
		assert.ok(supabase.stdout.includes('This comparison is required when the marker is missing.'));

		const turso = await runCli(['add', 'database', 'turso', '--print']);
		assert.equal(turso.code, 0);
		assert.ok(turso.stdout.includes('@flue/libsql'));
		assert.ok(turso.stdout.includes('TURSO_DATABASE_URL'));
		assert.ok(turso.stdout.includes('tx.close()'));

		for (const [name, url] of [
			['redis', 'REDIS_URL'],
			['valkey', 'VALKEY_URL'],
		]) {
			const result = await runCli(['add', 'database', name, '--print']);
			assert.equal(result.code, 0);
			assert.ok(result.stdout.includes('@flue/redis'));
			assert.ok(result.stdout.includes("from 'redis'"));
			assert.ok(result.stdout.includes(`// flue-blueprint: database/${name}@1`));
			assert.ok(result.stdout.includes(url));
			assert.ok(result.stdout.includes('command:'));
			assert.ok(result.stdout.includes('eval:'));
			assert.ok(result.stdout.includes('pipeline:'));
			assert.ok(result.stdout.includes('if (result instanceof Error) throw result'));
			assert.ok(result.stdout.includes('close:'));
			assert.ok(result.stdout.includes('inspectServer: false'));
			assert.ok(result.stdout.includes('keyPrefix'));
			assert.ok(result.stdout.includes('This comparison is required when the marker is missing.'));
		}
	});

	it('prints the Braintrust tooling blueprint with target-agnostic tracing', async () => {
		const result = await runCli(['add', 'tooling', 'braintrust', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('braintrust@3.17.0'));
		assert.ok(result.stdout.includes('braintrustFlueObserver'));
		assert.ok(result.stdout.includes("event.type === 'tool'"));
		assert.ok(result.stdout.includes("type: 'tool_call'"));
		assert.ok(result.stdout.includes("event.type === 'run_resume'"));
		assert.ok(result.stdout.includes('// flue-blueprint: tooling/braintrust@1'));
		assert.ok(result.stdout.includes('Node.js and Cloudflare'));
		assert.ok(result.stdout.includes('This comparison is required when the marker is missing.'));
	});

	it('prints the Sentry tooling blueprint with target-specific integration paths', async () => {
		const result = await runCli(['add', 'tooling', 'sentry', '--print']);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes('@sentry/node'));
		assert.ok(result.stdout.includes('@sentry/cloudflare'));
		assert.ok(result.stdout.includes('instrumentDurableObjectWithSentry'));
		assert.ok(result.stdout.includes("{ types: ['run_start', 'run_resume', 'run_end', 'log'] }"));
		assert.ok(result.stdout.includes('// flue-blueprint: tooling/sentry@1'));
		assert.ok(result.stdout.includes('This comparison is required when the marker is missing.'));
	});

	it('substitutes any absolute research URL into the generic kind blueprint', async () => {
		const url = 'git+ssh://git@example.test/provider.git';
		const result = await runCli(['add', 'channel', url, '--print']);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes(`\`${url}\``));
		assert.ok(!result.stdout.includes('{{URL}}'));
	});

	it('shell-quotes URLs in human instructions', async () => {
		const url = 'https://docs.example.test/?a=1&b=two';
		const result = await runCli(['add', 'channel', url]);
		assert.equal(result.code, 0);
		assert.ok(result.stderr.includes(`flue add channel '${url}'`));
		assert.ok(result.stderr.includes(`flue add channel '${url}' --print | claude`));
	});

	it('rejects an unknown kind with every known kind in the guidance', async () => {
		const result = await runCli(['add', 'unknown', 'https://docs.example.test', '--print']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Known kinds: channel, database, sandbox, tooling'));
	});

	it('rejects the removed category flag', async () => {
		const result = await runCli([
			'add',
			'https://docs.example.test',
			'--category',
			'channel',
			'--print',
		]);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Unknown flag for `flue add`: --category'));
	});

	it('rejects a legacy one-positional blueprint invocation', async () => {
		const result = await runCli(['add', 'slack', '--print']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing blueprint name or URL'));
	});

	it('rejects a blueprint name under the wrong kind', async () => {
		const result = await runCli(['add', 'database', 'slack', '--print']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Blueprint "slack" not found for kind "database"'));
		assert.ok(result.stderr.includes('flue add database postgres'));
		assert.ok(!result.stderr.includes('flue add channel slack'));
	});

	it('treats an unknown non-URL value as a blueprint name', async () => {
		const result = await runCli(['add', 'channel', 'unknown-provider', '--print']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Blueprint "unknown-provider" not found for kind "channel"'));
	});

	it('rejects an extra positional argument', async () => {
		const result = await runCli(['add', 'channel', 'slack', 'extra', '--print']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Unexpected extra argument for `flue add`: extra'));
	});
});

describe('flue update', () => {
	it('prints the exact same named blueprint as flue add', async () => {
		const added = await runCli(['add', 'channel', 'slack', '--print']);
		const updated = await runCli(['update', 'channel', 'slack', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
	});

	it('prints the exact same MongoDB blueprint as flue add', async () => {
		const added = await runCli(['add', 'database', 'mongodb', '--print']);
		const updated = await runCli(['update', 'database', 'mongodb', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(updated.stdout.includes('// flue-blueprint: database/mongodb@1'));
		assert.ok(updated.stdout.includes('This comparison is required when the marker is missing.'));
	});

	it('prints the exact same MySQL blueprint as flue add', async () => {
		const added = await runCli(['add', 'database', 'mysql', '--print']);
		const updated = await runCli(['update', 'database', 'mysql', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(updated.stdout.includes('// flue-blueprint: database/mysql@1'));
	});

	it('prints the exact same Supabase blueprint as flue add', async () => {
		const added = await runCli(['add', 'database', 'supabase', '--print']);
		const updated = await runCli(['update', 'database', 'supabase', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(updated.stdout.includes('// flue-blueprint: database/supabase@1'));
	});

	it('prints the exact same Redis and Valkey blueprints as flue add', async () => {
		for (const name of ['redis', 'valkey']) {
			const added = await runCli(['add', 'database', name, '--print']);
			const updated = await runCli(['update', 'database', name, '--print']);

			assert.equal(updated.code, 0);
			assert.equal(updated.stdout, added.stdout);
			assert.ok(updated.stdout.includes(`// flue-blueprint: database/${name}@1`));
		}
	});

	it('prints the exact same Braintrust blueprint as flue add', async () => {
		const added = await runCli(['add', 'tooling', 'braintrust', '--print']);
		const updated = await runCli(['update', 'tooling', 'braintrust', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(updated.stdout.includes('// flue-blueprint: tooling/braintrust@1'));
	});

	it('prints the exact same Sentry blueprint as flue add', async () => {
		const added = await runCli(['add', 'tooling', 'sentry', '--print']);
		const updated = await runCli(['update', 'tooling', 'sentry', '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(updated.stdout.includes('// flue-blueprint: tooling/sentry@1'));
	});

	it('prints the exact same URL-substituted blueprint as flue add', async () => {
		const url = 'https://docs.example.test/?version=2&source=cli';
		const added = await runCli(['add', 'channel', url, '--print']);
		const updated = await runCli(['update', 'channel', url, '--print']);

		assert.equal(updated.code, 0);
		assert.equal(updated.stdout, added.stdout);
		assert.ok(!updated.stdout.includes('{{URL}}'));
	});

	it('uses the invoked command in human instructions', async () => {
		const result = await runCli(['update', 'channel', 'slack']);

		assert.equal(result.code, 0);
		assert.ok(result.stderr.includes("flue update channel 'slack'"));
		assert.ok(result.stderr.includes("flue update channel 'slack' --print | claude"));
		assert.ok(!result.stderr.includes('flue add channel slack'));
	});

	it('requires both positional arguments instead of listing blueprints', async () => {
		const missingBoth = await runCli(['update']);
		const missingName = await runCli(['update', 'channel']);

		assert.equal(missingBoth.code, 1);
		assert.ok(missingBoth.stderr.includes('flue update <kind> <name|url> [--print]'));
		assert.ok(!missingBoth.stderr.includes('Available blueprints:'));
		assert.equal(missingName.code, 1);
		assert.ok(missingName.stderr.includes('Missing blueprint name or URL'));
	});
});
