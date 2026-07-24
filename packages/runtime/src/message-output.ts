import * as v from 'valibot';
import { RESERVED_SIGNAL_TYPES } from './conversation-records.ts';
import type { FlueHarness, FlueLogger, PromptUsage } from './types.ts';

/**
 * The output channels behind the client-facing hooks. Data parts
 * (`useDataWriter`) and response metadata (returned from
 * `useResponseStart`/`useResponseFinish`) decorate the agent's response
 * message for clients and never reach the model; model-facing appends
 * (`ctx.append` in `useAgentFinish`) write signal records into the agent's
 * own conversation history. All of it is write-only and non-reactive —
 * nothing here re-runs the agent.
 */

/**
 * The context a `useResponseStart` callback receives. `metadata` is the
 * response metadata accumulated so far this response (earlier hooks'
 * contributions, in declaration order) — handed in at call time, so it is
 * never a stale render capture.
 */
export interface ResponseStartContext {
	readonly metadata: Record<string, unknown>;
	readonly log: FlueLogger;
}

/**
 * The context a `useResponseFinish` callback receives: the accumulated
 * response metadata (including what `useResponseStart` hooks attached — read
 * from the durable record log, so it survives re-attempts) and the response's
 * final aggregates.
 */
export interface ResponseFinishContext {
	readonly metadata: Record<string, unknown>;
	readonly response: {
		/** The response's aggregate usage across all turns and re-attempts. */
		readonly usage: PromptUsage;
		/** Every tool call the response made, from the durable record log. */
		readonly toolCalls: readonly AgentResponseToolCall[];
	};
	readonly log: FlueLogger;
}

/**
 * A response boundary callback: returns a plain object to deep-merge onto the
 * response message's metadata, or nothing. Boundary hooks are synchronous
 * observers — a returned promise throws.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a boundary callback may observe without attaching metadata — a bare no-return body is legal, which `| undefined` alone would reject.
export type ResponseMetadataCallback<TCtx> = (ctx: TCtx) => Record<string, unknown> | void;

/** One `useResponseStart` declaration; identity is the declaration index. */
export interface ResponseStartDeclaration {
	run: ResponseMetadataCallback<ResponseStartContext>;
}

/** One `useResponseFinish` declaration; identity is the declaration index. */
export interface ResponseFinishDeclaration {
	run: ResponseMetadataCallback<ResponseFinishContext>;
}

/**
 * One finish-continuation append: a signal authored by agent code into the
 * current agent's conversation history. Field-for-field the code-side twin
 * of a `kind: 'signal'` delivered message (same validation, same rendering)
 * — minus delivery semantics: an append steers the response the agent is
 * producing right now and is never a delivery (no `useAgentStart` run, no
 * submission of its own).
 */
export interface AgentSignalAppend {
	type: string;
	body: string;
	attributes?: Record<string, string>;
	tagName?: string;
}

/**
 * The message shape `ctx.append` (on `AgentFinishContext`) accepts: the same
 * signal form `dispatch()` messages use, so appending and dispatching share
 * one vocabulary. Only `kind: 'signal'` is accepted — a `kind: 'user'`
 * message is real new input and belongs on `useDispatchMessage()`.
 */
export interface AgentAppendMessage extends AgentSignalAppend {
	kind: 'signal';
}

const AppendMessageSchema = v.strictObject(
	{
		kind: v.literal('signal', 'message "kind" must be "signal"'),
		type: v.pipe(v.string(), v.nonEmpty('signal "type" must not be empty')),
		body: v.string('signal "body" must be a string'),
		attributes: v.optional(v.record(v.string(), v.string())),
		// The tag name is rendered unescaped as the signal's XML envelope in
		// model context, so it must be a valid XML name — anything looser would
		// let a caller-controlled value inject markup that the body/attribute
		// escaping exists to prevent. Same rule as delivered signal messages.
		tagName: v.optional(
			v.pipe(
				v.string(),
				v.regex(
					/^[A-Za-z_][A-Za-z0-9_.-]*$/,
					'signal "tagName" must be a valid XML tag name ' +
						'(letters, digits, "_", "-", "."; must not start with a digit, "-", or ".")',
				),
			),
		),
	},
	(issue) =>
		issue.expected === 'never' ? `received unknown signal field ${issue.received}` : issue.message,
);

/** Validate one `ctx.append` argument; throws with field-level detail. */
export function assertAppendMessage(message: unknown): AgentSignalAppend {
	if (
		typeof message === 'object' &&
		message !== null &&
		(message as { kind?: unknown }).kind === 'user'
	) {
		throw new Error(
			'[flue] append() only appends kind: "signal" messages into the running response. A kind: "user" message is real new input — send it with the dispatcher from useDispatchMessage() instead.',
		);
	}
	const parsed = v.safeParse(AppendMessageSchema, message);
	if (!parsed.success) {
		throw new Error(
			`[flue] append() message is invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}.`,
		);
	}
	// Reserved types are what lets the runtime treat a reserved-type record as
	// framework-authored (recovery classification, the `useDelivery()` resume
	// filter) — an agent-authored one would corrupt those readers.
	if (RESERVED_SIGNAL_TYPES.has(parsed.output.type)) {
		throw new Error(
			`[flue] append() signal type "${parsed.output.type}" is framework-reserved vocabulary (the runtime's own narration and recovery signals) — use an application-specific type.`,
		);
	}
	const { type, body, attributes, tagName } = parsed.output;
	return {
		type,
		body,
		...(attributes ? { attributes } : {}),
		...(tagName ? { tagName } : {}),
	};
}

/**
 * The context a `useAgentStart` callback receives. `log` emits progress lines
 * into the conversation stream (the model never sees them); `signal` is the
 * submission's abort signal; `harness` is the invocation-scoped runtime
 * surface (sandbox `shell`/`fs`, child sessions, model calls) — materialized
 * lazily on first access, so a callback that never touches it pays nothing.
 * To put something in front of the model, dispatch a signal with the
 * dispatcher from `useDispatchMessage()` — it joins this same response
 * before the model's next turn. `append` is the low-level alternative
 * (parity with `useAgentFinish`): it writes a signal into this response
 * WITHOUT registering a delivery — no `useAgentStart` run of its own, no
 * submission — and is legal only during the callback's execution window.
 * Prefer dispatching; reach for `append` only when a delivery is wrong.
 */
export interface AgentStartContext {
	readonly append: (message: AgentAppendMessage) => void;
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
	readonly signal: AbortSignal;
}

/** One tool call the current response has made, from the durable record log. */
export interface AgentResponseToolCall {
	/** The tool's name as the model called it. */
	tool: string;
	/** Whether the call's recorded outcome was an error. */
	isError: boolean;
}

/**
 * The context a `useAgentFinish` callback receives: the `useAgentStart`
 * surface plus visibility into the response so far and the continuation
 * writer. `response.toolCalls` aggregates every tool call the response has
 * made — across all turns and across re-attempts (derived from durable
 * records, so a resumed response still sees calls made before an
 * interruption); `response.usage` is the aggregate usage so far, a steering
 * input for budget-aware continuation decisions (the settled total belongs to
 * `useResponseFinish`). `append` steers a signal into the same response — the model
 * reads it on the continuation turn and this hook fires again at the next
 * would-stop — and is legal only during the callback's execution window
 * (a captured reference throws after the callback settles). Appends are the
 * response steering itself: no `useAgentStart` run, no submission of their
 * own, counted against the framework's continuation ceiling. For real new
 * input, dispatch instead.
 */
export interface AgentFinishContext {
	readonly response: {
		readonly toolCalls: readonly AgentResponseToolCall[];
		readonly usage: PromptUsage;
	};
	readonly append: (message: AgentAppendMessage) => void;
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
	readonly signal: AbortSignal;
}

/** One `useAgentStart` declaration; identity is the declaration index. */
export interface AgentStartDeclaration {
	run: (ctx: AgentStartContext) => void | Promise<void>;
}

/** One `useAgentFinish` declaration; identity is the declaration index. */
export interface AgentFinishDeclaration {
	run: (ctx: AgentFinishContext) => void | Promise<void>;
}

/**
 * The output channel shared between renders and the session, mirroring the
 * `usePersistentState` buffer pattern: created once per harness lifetime, handed to
 * both sides. Renders replace the boundary and lifecycle declarations
 * wholesale each render (fresh closures); `useDataWriter` writers call
 * `writeMessageData`; the session connects the sink that reaches the
 * durable log. (Finish-continuation appends never pass through here: the
 * session constructs `ctx.append` directly when it runs the callbacks.)
 */
export interface AgentOutputChannel {
	/** `useResponseStart` declarations from the latest render, in call order. */
	responseStarts: ResponseStartDeclaration[];
	/** `useResponseFinish` declarations from the latest render, in call order. */
	responseFinishes: ResponseFinishDeclaration[];
	/** `useAgentStart` declarations from the latest render, in call order. */
	agentStarts: AgentStartDeclaration[];
	/** `useAgentFinish` declarations from the latest render, in call order. */
	agentFinishes: AgentFinishDeclaration[];
	/** Wire the session-side sink data writes flow into. */
	connect(sink: (name: string, data: unknown) => void): void;
	writeMessageData(name: string, data: unknown): void;
}

export function createAgentOutputChannel(): AgentOutputChannel {
	let sink: ((name: string, data: unknown) => void) | undefined;
	return {
		responseStarts: [],
		responseFinishes: [],
		agentStarts: [],
		agentFinishes: [],
		connect(next) {
			sink = next;
		},
		writeMessageData(name, data) {
			if (!sink) {
				throw new Error(
					`[flue] Message data "${name}" has no durable runtime behind this render, so writes are unavailable.`,
				);
			}
			sink(name, data);
		},
	};
}

/**
 * Run one boundary's hooks in declaration order and deep-merge their returned
 * metadata. Each callback's context is built at call time over the metadata
 * accumulated so far (`initialMetadata`, then earlier hooks' contributions in
 * order) — so a later hook can compute over an earlier hook's keys with no
 * stale capture. Returns only what the hooks contributed (`undefined` when
 * none did); the caller owns merging that into the durable stream.
 *
 * Fail-fast on purpose: a callback throw propagates (wrapped with the hook
 * name for context) and fails the submission through the normal failure path
 * — never retried, never in durability recovery. A returned promise is the
 * same failure: boundary hooks are synchronous observers.
 */
export function runResponseMetadataHooks<TCtx>(
	hookName: 'useResponseStart' | 'useResponseFinish',
	declarations: readonly { run: ResponseMetadataCallback<TCtx> }[],
	createContext: (metadata: Record<string, unknown>, index: number) => TCtx,
	initialMetadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
	let current = initialMetadata;
	let contributed: Record<string, unknown> | undefined;
	for (const [index, declaration] of declarations.entries()) {
		let result: ReturnType<ResponseMetadataCallback<TCtx>>;
		try {
			result = declaration.run(createContext(current, index));
		} catch (error) {
			throw new Error(
				`[flue] A ${hookName} callback (hook #${index} in declaration order) threw: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (result === undefined || result === null) continue;
		if (typeof result !== 'object') {
			throw new Error(
				`[flue] A ${hookName} callback must return a plain object of metadata (or nothing) — got ${typeof result}.`,
			);
		}
		if (isThenable(result)) {
			throw new Error(
				`[flue] A ${hookName} callback (hook #${index} in declaration order) returned a promise. Response boundary hooks are synchronous observers of the response envelope — return the metadata object directly. Move async work into useAgentStart/useAgentFinish (awaited lifecycle hooks) or tools.`,
			);
		}
		if (Array.isArray(result)) {
			throw new Error(
				`[flue] A ${hookName} callback must return a plain object of metadata (or nothing) — got an array.`,
			);
		}
		current = deepMergeMetadata(current, result);
		contributed = deepMergeMetadata(contributed ?? {}, result);
	}
	return contributed && Object.keys(contributed).length > 0 ? contributed : undefined;
}

function isThenable(value: object): boolean {
	return 'then' in value && typeof (value as { then: unknown }).then === 'function';
}

/**
 * Deep-merge metadata objects: later values win, `undefined` is skipped,
 * plain objects merge recursively, and prototype-polluting keys are dropped.
 * Always returns a fresh object — inputs are never mutated (reducer state
 * relies on this for cheap cloning).
 */
export function deepMergeMetadata(
	base: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue;
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
		const current = merged[key];
		merged[key] =
			isPlainObject(current) && isPlainObject(value) ? deepMergeMetadata(current, value) : value;
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
