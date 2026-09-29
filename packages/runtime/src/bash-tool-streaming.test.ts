import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { createBashTool, init, instrument, useModel, useSandbox } from './index.ts';
import { local, sqlite, start } from './node/index.ts';
import type { FlueObservation, Sandbox } from './types.ts';

it('streams cumulative sandbox output through bash tool updates', async () => {
	let execOptions: Parameters<Sandbox['exec']>[1];
	const sandbox = {
		exec: vi.fn<Sandbox['exec']>(async (_command, options) => {
			execOptions = options;
			options?.onOutput?.('stdout', 'hello ');
			options?.onOutput?.('stderr', 'warning');
			options?.onOutput?.('stdout', 'world');
			return { stdout: 'hello world', stderr: 'warning', exitCode: 0 };
		}),
	} as unknown as Sandbox;
	const updates: unknown[] = [];

	const result = await createBashTool(sandbox).execute(
		'call_bash',
		{ command: 'run' },
		undefined,
		(update) => updates.push(update),
	);

	expect(execOptions?.onOutput).toBeTypeOf('function');
	expect(updates.at(-1)).toEqual({
		content: [{ type: 'text', text: 'hello world\nwarning' }],
		details: { command: 'run' },
	});
	expect(result).toEqual({
		content: [{ type: 'text', text: 'hello world\nwarning' }],
		details: { command: 'run', exitCode: 0 },
	});
});

it('keeps bash tool execution buffered when updates are not observed', async () => {
	let execOptions: Parameters<Sandbox['exec']>[1];
	const sandbox = {
		exec: vi.fn<Sandbox['exec']>(async (_command, options) => {
			execOptions = options;
			return { stdout: 'done', stderr: '', exitCode: 0 };
		}),
	} as unknown as Sandbox;

	await createBashTool(sandbox).execute('call_bash', { command: 'run' });

	expect(execOptions).not.toHaveProperty('onOutput');
});

it('stops bash tool updates after cancellation', async () => {
	const pending = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
	let onOutput: NonNullable<Parameters<Sandbox['exec']>[1]>['onOutput'];
	const sandbox = {
		exec: vi.fn<Sandbox['exec']>((_command, options) => {
			onOutput = options?.onOutput;
			onOutput?.('stdout', 'started');
			return pending.promise;
		}),
	} as unknown as Sandbox;
	const controller = new AbortController();
	const updates: unknown[] = [];
	const execution = createBashTool(sandbox).execute(
		'call_bash',
		{ command: 'run' },
		controller.signal,
		(update) => updates.push(update),
	);

	controller.abort('stop');
	onOutput?.('stdout', ' late');
	pending.resolve({ stdout: 'started late', stderr: '', exitCode: 0 });
	await execution;

	expect(updates).toEqual([
		{
			content: [{ type: 'text', text: 'started' }],
			details: { command: 'run' },
		},
	]);
});

it('publishes Pi tool updates as live Flue events', async () => {
	function StreamingToolAgent() {
		useModel('faux/model');
		useSandbox({
			...local(),
			tools: () => [
				{
					name: 'progress',
					label: 'Progress',
					description: 'Report progress.',
					parameters: { type: 'object', properties: {} },
					async execute(_id, _args, _signal, onUpdate) {
						onUpdate?.({
							content: [{ type: 'text', text: 'working' }],
							details: { phase: 1 },
						});
						return {
							content: [{ type: 'text', text: 'done' }],
							details: { phase: 2 },
						};
					},
				},
			],
		});
		return 'Run the progress tool.';
	}

	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('progress', {}, { id: 'call_progress' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText('Finished.')], { stopReason: 'stop' }),
	]);
	const observations: FlueObservation[] = [];
	const disposeInstrumentation = instrument({
		dispose() {},
		observe(event) {
			observations.push(event);
		},
		interceptor(_operation, _context, next) {
			return next();
		},
	});
	const runtime = await start({
		agents: [StreamingToolAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(StreamingToolAgent, { id: 'tool-update-events' });

	try {
		await agent.read(await agent.dispatch('Run it.'));
		expect(
			observations.find(
				(event) => event.type === 'tool_update' && event.toolCallId === 'call_progress',
			),
		).toMatchObject({
			type: 'tool_update',
			toolName: 'progress',
			toolCallId: 'call_progress',
			result: {
				content: [{ type: 'text', text: 'working' }],
				details: { phase: 1 },
			},
			origin: 'adapter',
		});
	} finally {
		await agent.abort();
		await runtime.stop();
		await disposeInstrumentation();
	}
});
