import { bash, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init }: FlueContext) {
	const fs = new InMemoryFs();
	const harness = await init({ sandbox: bash(() => new Bash({ fs })), model: false });
	const session = await harness.session();
	await session.shell('echo "custom bash succeeded" > proof.txt');
	const result = await session.shell('cat proof.txt');
	return { text: result.stdout.trim() };
}
