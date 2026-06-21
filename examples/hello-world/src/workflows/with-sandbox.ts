import { Daytona } from '@daytona/sdk';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(async ({ env }) => {
	const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
	return { sandbox: daytona(await client.create()), model: 'anthropic/claude-sonnet-4-6' };
});

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const uname = await session.shell('uname -a');
		const unameOk = uname.exitCode === 0 && uname.stdout.includes('Linux');
		await session.shell('echo "hello from sandbox" > /tmp/test.txt');
		const fileOk =
			(await session.shell('cat /tmp/test.txt')).stdout.trim() === 'hello from sandbox';
		const compound = await session.shell('echo step1 && echo step2');
		const compoundOk = compound.stdout.includes('step1') && compound.stdout.includes('step2');
		const pipe = await session.shell('echo -e "a\\nb\\nc" | wc -l');
		const pipeOk = pipe.exitCode === 0 && pipe.stdout.trim() === '3';
		await session.shell('echo "redirected content" > /tmp/redirect-test.txt');
		const redirectOk =
			(await session.shell('cat /tmp/redirect-test.txt')).stdout.trim() === 'redirected content';
		await session.shell(
			'mkdir -p /tmp/pipe-test && touch /tmp/pipe-test/a.txt /tmp/pipe-test/b.txt /tmp/pipe-test/c.txt',
		);
		const findWc = await session.shell('find /tmp/pipe-test -type f | wc -l');
		const findWcOk = findWc.exitCode === 0 && findWc.stdout.trim() === '3';
		return {
			unameOk,
			fileOk,
			compoundOk,
			pipeOk,
			redirectOk,
			findWcOk,
			allPassed: unameOk && fileOk && compoundOk && pipeOk && redirectOk && findWcOk,
		};
	},
});
