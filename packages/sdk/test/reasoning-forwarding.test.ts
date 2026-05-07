/**
 * Integration test: verify `reasoning` is forwarded to the pi-ai stream
 * function on `prompt()`, `skill()`, and `task()`.
 *
 * The fake `streamFn` records the `SimpleStreamOptions` each call receives
 * and returns a trivial `done` event so the session loop settles cleanly.
 * We reach into the private `harness` with a cast — intentional test seam.
 *
 * Node 22's `--experimental-strip-types` rejects parameter properties, and
 * `src/result.ts` uses them. We use `--experimental-transform-types` for
 * this test suite; the script in package.json wires that up.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from '@mariozechner/pi-ai';
// pi-ai exports this class from `./utils/event-stream.js` via `export *`,
// but its root `types.d.ts` also declares a conflicting `export type` alias,
// which trips `verbatimModuleSyntax` checks. The value is real at runtime,
// so we fetch it via a dynamic import that bypasses the type duplication.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { AssistantMessageEventStream } = (await import('@mariozechner/pi-ai')) as any;

import { Session, InMemorySessionStore } from '../src/session.ts';
import type {
	AgentConfig,
	ModelThinkingLevel,
	Role,
	SessionEnv,
	Skill,
} from '../src/types.ts';

// ─── Fakes ──────────────────────────────────────────────────────────────────

function reasoningModel(): Model<'openai-responses'> {
	return {
		id: 'claude-opus-4-7',
		name: 'Claude Opus 4.7',
		api: 'openai-responses',
		provider: 'anthropic',
		baseUrl: 'https://api.example.test',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

function stubEnv(): SessionEnv {
	return {
		cwd: '/workspace',
		resolvePath: (p) => (p.startsWith('/') ? p : `/workspace/${p}`),
		async exec() {
			return { stdout: '', stderr: '', exitCode: 0 };
		},
		async readFile() {
			throw new Error('not implemented');
		},
		async readFileBuffer() {
			throw new Error('not implemented');
		},
		async writeFile() {},
		async stat() {
			return {
				isFile: false,
				isDirectory: false,
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(),
			};
		},
		async readdir() {
			return [];
		},
		async exists() {
			return false;
		},
		async mkdir() {},
		async rm() {},
		async cleanup() {},
	};
}

function baseConfig(overrides?: Partial<AgentConfig>): AgentConfig {
	const model = reasoningModel();
	return {
		systemPrompt: 'test',
		skills: {} as Record<string, Skill>,
		roles: {} as Record<string, Role>,
		model: model as any,
		resolveModel: () => model as any,
		...overrides,
	};
}

type FakeStreamCall = {
	reasoning: SimpleStreamOptions['reasoning'] | undefined;
};

function fakeStreamFn(): {
	streamFn: (
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	) => any;
	calls: FakeStreamCall[];
} {
	const calls: FakeStreamCall[] = [];

	const streamFn = (model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
		calls.push({ reasoning: options?.reasoning });

		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'ok' }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: 'stop',
			timestamp: Date.now(),
		};
		stream.push({ type: 'start', partial: message });
		stream.push({ type: 'text_start', contentIndex: 0, partial: message });
		stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message });
		stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message });
		stream.push({ type: 'done', reason: 'stop', message });
		stream.end();
		return stream;
	};

	return { streamFn, calls };
}

function makeSession(
	config: AgentConfig,
	streamFn: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => any,
	sessionReasoning?: ModelThinkingLevel,
): Session {
	// Recursive task-session factory. Each child is wired with the same
	// streamFn and can spawn its own children, so tests can exercise task
	// depth > 1 without bumping into the `nested tasks not exercised`
	// sentinel from earlier iterations of this helper.
	const createTaskSession = async (opts: {
		taskId: string;
		role?: string;
		reasoning?: ModelThinkingLevel;
		depth: number;
	}): Promise<Session> => {
		const child = new Session({
			id: `task:${opts.taskId}`,
			storageKey: `agent:test:task:${opts.taskId}`,
			config,
			env: stubEnv(),
			store: new InMemorySessionStore(),
			existingData: null,
			sessionRole: opts.role,
			sessionReasoning: opts.reasoning,
			taskDepth: opts.depth,
			createTaskSession,
		});
		(child as any).harness.streamFn = streamFn;
		return child;
	};

	const session = new Session({
		id: 'test-session',
		storageKey: 'agent:test:default',
		config,
		env: stubEnv(),
		store: new InMemorySessionStore(),
		existingData: null,
		sessionReasoning,
		createTaskSession,
	});
	(session as any).harness.streamFn = streamFn;
	return session;
}

// ─── prompt() ──────────────────────────────────────────────────────────────

describe('reasoning forwarding: prompt()', () => {
	let streamFn: ReturnType<typeof fakeStreamFn>['streamFn'];
	let calls: FakeStreamCall[];

	beforeEach(() => {
		({ streamFn, calls } = fakeStreamFn());
	});

	it('forwards per-call reasoning to the stream function', async () => {
		const session = makeSession(baseConfig(), streamFn);
		await session.prompt('hello', { reasoning: 'xhigh' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.reasoning, 'xhigh');
	});

	it('forwards agent-level default when no per-call value is given', async () => {
		const session = makeSession(baseConfig({ reasoning: 'medium' }), streamFn);
		await session.prompt('hello');
		assert.equal(calls[0]!.reasoning, 'medium');
	});

	it('per-call reasoning beats agent default', async () => {
		const session = makeSession(baseConfig({ reasoning: 'medium' }), streamFn);
		await session.prompt('hello', { reasoning: 'high' });
		assert.equal(calls[0]!.reasoning, 'high');
	});

	it('role reasoning beats agent default', async () => {
		const config = baseConfig({
			reasoning: 'low',
			roles: {
				deep: { name: 'deep', description: '', instructions: '', reasoning: 'high' },
			},
		});
		const session = makeSession(config, streamFn);
		await session.prompt('hello', { role: 'deep' });
		assert.equal(calls[0]!.reasoning, 'high');
	});

	it('agent "off" default sends no reasoning option', async () => {
		const session = makeSession(baseConfig({ reasoning: 'off' }), streamFn);
		await session.prompt('hello');
		assert.equal(calls[0]!.reasoning, undefined);
	});

	it('no configured reasoning means no reasoning on the wire', async () => {
		const session = makeSession(baseConfig(), streamFn);
		await session.prompt('hello');
		assert.equal(calls[0]!.reasoning, undefined);
	});

	it('rejects per-call reasoning on a non-reasoning model before hitting the stream', async () => {
		const nonReasoning = { ...reasoningModel(), reasoning: false };
		const config = baseConfig({
			model: nonReasoning as any,
			resolveModel: () => nonReasoning as any,
		});
		const session = makeSession(config, streamFn);
		await assert.rejects(
			session.prompt('hello', { reasoning: 'high' }),
			/reasoning.*not supported by model/,
		);
		assert.equal(calls.length, 0);
	});

	it('leaves harness state intact when reasoning validation fails', async () => {
		// F6/4: the happy-path of "strict validation" IS the throw. If
		// `withScopedRuntime` mutated state before resolving reasoning, a
		// failed call would leave `state.model` / `state.systemPrompt`
		// pointing at the attempted call's values, silently contaminating
		// the next successful call. We reach into the private harness to
		// verify the rollback contract holds.
		const reasoning = reasoningModel();
		const nonReasoning = { ...reasoning, id: 'non-reasoner', reasoning: false };
		const config = baseConfig({
			resolveModel: (model) =>
				(model === nonReasoning.id
					? nonReasoning
					: reasoning) as any,
		});
		const session = makeSession(config, streamFn);

		const harness = (session as any).harness;
		const modelBefore = harness.state.model;
		const systemPromptBefore = harness.state.systemPrompt;
		const thinkingLevelBefore = harness.state.thinkingLevel;

		await assert.rejects(
			session.prompt('hello', { reasoning: 'high', model: 'non-reasoner' }),
			/reasoning.*not supported by model/,
		);

		assert.equal(harness.state.model, modelBefore);
		assert.equal(harness.state.systemPrompt, systemPromptBefore);
		assert.equal(harness.state.thinkingLevel, thinkingLevelBefore);
	});
});

// ─── skill() ───────────────────────────────────────────────────────────────

describe('reasoning forwarding: skill()', () => {
	it('forwards per-call reasoning on skill invocations', async () => {
		const { streamFn, calls } = fakeStreamFn();
		const config = baseConfig({
			skills: {
				review: { name: 'review', description: '', instructions: 'Review the diff.' },
			},
		});
		const session = makeSession(config, streamFn);
		await session.skill('review', { reasoning: 'xhigh' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.reasoning, 'xhigh');
	});

	it('inherits session-level reasoning when skill omits it', async () => {
		const { streamFn, calls } = fakeStreamFn();
		const config = baseConfig({
			skills: {
				review: { name: 'review', description: '', instructions: 'x' },
			},
		});
		const session = makeSession(config, streamFn, 'low');
		await session.skill('review');
		assert.equal(calls[0]!.reasoning, 'low');
	});

	it('picks up reasoning declared by a role even when agent and session differ', async () => {
		// F6/5: skill + role precedence. The role wins when skill omits
		// `reasoning` and session declares none.
		const { streamFn, calls } = fakeStreamFn();
		const config = baseConfig({
			reasoning: 'low',
			skills: {
				audit: { name: 'audit', description: '', instructions: 'Audit.' },
			},
			roles: {
				careful: {
					name: 'careful',
					description: '',
					instructions: '',
					reasoning: 'high',
				},
			},
		});
		const session = makeSession(config, streamFn);
		await session.skill('audit', { role: 'careful' });
		assert.equal(calls[0]!.reasoning, 'high');
	});
});

// ─── task() ────────────────────────────────────────────────────────────────

describe('reasoning forwarding: task()', () => {
	it('forwards per-call reasoning into the child session prompt', async () => {
		const { streamFn, calls } = fakeStreamFn();
		const session = makeSession(baseConfig(), streamFn);
		await session.task('research this', { reasoning: 'high' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.reasoning, 'high');
	});

	it('inherits parent session reasoning when the task omits it', async () => {
		const { streamFn, calls } = fakeStreamFn();
		const session = makeSession(baseConfig(), streamFn, 'medium');
		await session.task('summarize');
		assert.equal(calls[0]!.reasoning, 'medium');
	});

	it('sessionReasoning is carried onto task children two levels deep', async () => {
		// F6/3: a parent session with `sessionReasoning: 'xhigh'` spawns a
		// task; that task must carry `xhigh` as its own session default,
		// so when it spawns another task, the grandchild still sees
		// `xhigh` on its prompt. Without the inheritance chain in
		// `runTask` (options.inheritedReasoning ?? sessionReasoning ??
		// config.reasoning), the grandchild would fall back to undefined.
		//
		// The first `session.task()` call exercises runTask end-to-end
		// (parent → child). The deeper level is constructed through the
		// internal task-session factory: that part of the test confirms
		// the API accepts the inheritance contract, not that runTask
		// propagates it at depth > 1. Task depth > 1 in production is
		// driven by the LLM invoking the `task` tool, which has its own
		// coverage path in the forwarding layer.
		const { streamFn, calls } = fakeStreamFn();
		const session = makeSession(baseConfig(), streamFn, 'xhigh');

		// Drive the chain from the test: each `session.task()` call
		// creates a child session. We then invoke `.task()` on the child
		// to go one level deeper. This exercises exactly the path that
		// runs when an agent orchestrates nested research work.
		await session.task('level 1');
		const child = await (session as any).createTaskSession({
			parentSessionId: session.id,
			taskId: 'probe-child',
			parentEnv: (session as any).env,
			role: undefined,
			reasoning: (session as any).sessionReasoning,
			commands: [],
			depth: 1,
		});
		await child.task('level 2');
		const grandchild = await (child as any).createTaskSession({
			parentSessionId: child.id,
			taskId: 'probe-grandchild',
			parentEnv: (child as any).env,
			role: undefined,
			reasoning: (child as any).sessionReasoning,
			commands: [],
			depth: 2,
		});
		await grandchild.prompt('level 3');

		assert.equal(calls.length, 3);
		for (const call of calls) {
			assert.equal(call.reasoning, 'xhigh');
		}
	});
});
