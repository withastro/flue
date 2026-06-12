import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
	if (!existsSync('dist/index.mjs')) {
		execFileSync('pnpm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });
	}
});

describe('package entrypoints', () => {
	it('exposes shared channel helpers when a consumer imports @flue/channels', async () => {
		const channel = await import('@flue/channels');

		expect(channel).toMatchObject({
			hmacSha256Hex: expect.any(Function),
			resolveLazyValue: expect.any(Function),
			timingSafeEqual: expect.any(Function),
			verifyHmacSha256Signature: expect.any(Function),
		});
	});

	it('exposes Slack helpers when a consumer imports @flue/channels/slack', async () => {
		const slack = await import('@flue/channels/slack');

		expect(slack.createSlackChannel).toEqual(expect.any(Function));
	});

	it('exposes GitHub helpers when a consumer imports @flue/channels/github', async () => {
		const github = await import('@flue/channels/github');

		expect(github.createGitHubChannel).toEqual(expect.any(Function));
	});
});
