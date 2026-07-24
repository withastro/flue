import type { McpConnectionDefinition } from '../mcp-types.ts';
import type {
	AgentFinishDeclaration,
	AgentOutputChannel,
	AgentStartDeclaration,
	ResponseFinishDeclaration,
	ResponseStartDeclaration,
} from '../message-output.ts';
import type { ToolDefinition } from '../tool-types.ts';
import type {
	CompactionConfig,
	DeliveredMessage,
	SandboxFactory,
	Skill,
	SubagentDefinition,
	ThinkingLevel,
} from '../types.ts';

/**
 * The render frame: the module-global slot Flue Hooks resolve against while
 * an agent function runs. Same discipline as Preact's `currentComponent` —
 * agent functions are synchronous, so a single slot never interleaves; it is
 * set for exactly the duration of one render, and hooks throw when it is
 * empty (called from tools, events, or module scope).
 *
 * All attachments land flat on the frame in call order — a custom hook is a
 * plain function, so hooks it calls record exactly as if the agent body had
 * called them directly.
 */

/**
 * Durable hook state made available to one render: the reduced snapshot to
 * read values from, and the store setters write through. Absent when there is
 * no durable runtime behind the render (direct `renderAgentFunction` calls in
 * tests/tooling) — `usePersistentState` then reads defaults and its setters throw.
 */
export interface RenderStateContext {
	snapshot: ReadonlyMap<string, unknown>;
	store: HookStateStore | undefined;
	/**
	 * The agent instance id backing this render, threaded into the root
	 * agent function as `AgentProps.id`. Absent on bare tooling/test renders —
	 * reading `props.id` there throws.
	 */
	instanceId?: string;
	/**
	 * The agent's registered name backing this render — with `instanceId`,
	 * the self address `useDispatchMessage()` binds to. Absent on bare
	 * tooling/test renders, where the dispatcher throws on call.
	 */
	agentName?: string;
	/**
	 * The client-facing output channel (`useDataWriter` writes,
	 * lifecycle and boundary hook declarations). Absent when there is no
	 * durable runtime behind the render — data writers then throw on call.
	 */
	output?: AgentOutputChannel;
	/**
	 * The delivered message that triggered the run this render belongs to —
	 * identical for a direct HTTP prompt and a `dispatch()` call, and constant
	 * across every render of one submission attempt (the harness is initialized
	 * per attempt with the durable submission input). Absent when no delivered
	 * message triggered the run (tests/tooling renders, delegated operations).
	 */
	delivery?: DeliveredMessage;
	/**
	 * Instance-creation data (already schema-parsed when the agent declares
	 * an `initialData` schema). Constant for the instance's life; read via
	 * `useInitialData()`.
	 * Absent when creation carried none, on bare tooling/test renders, and in
	 * subagent frames (delegates have no creation data of their own).
	 */
	initialData?: unknown;
}

/** The write channel `usePersistentState` setters push into; drained by the session. */
export interface HookStateStore {
	write(name: string, value: unknown): void;
	current(name: string): { value: unknown } | undefined;
}

export interface RenderFrame {
	/**
	 * What is being rendered: a root agent, or a delegate's agent function rendered
	 * at delegation time. Subagent frames reject the hooks whose contracts are
	 * root-scoped (`usePersistentState` — durable state is instance-scoped; `useSandbox`
	 * — delegates share the parent environment).
	 */
	kind: 'agent' | 'subagent';
	/** `useInstruction()` contributions, in call order. */
	instructions: string[];
	/** `useTool()` mounts, in call order. */
	tools: ToolDefinition[];
	/** `usePersistentState` names declared this render; duplicates throw. */
	stateNames: Set<string>;
	/** `useDataWriter` names declared this render; duplicates throw. */
	messageDataNames: Set<string>;
	/** `useResponseStart` declarations this render, in call order (identity = index). */
	responseStarts: ResponseStartDeclaration[];
	/** `useResponseFinish` declarations this render, in call order (identity = index). */
	responseFinishes: ResponseFinishDeclaration[];
	/** `useAgentStart` declarations this render, in call order (identity = index). */
	agentStarts: AgentStartDeclaration[];
	/** `useAgentFinish` declarations this render, in call order (identity = index). */
	agentFinishes: AgentFinishDeclaration[];
	/** The render's `useSandbox` attachment; at most one per render. */
	sandbox: SandboxFactory | undefined;
	/** The render's `useSandbox` working directory (`{ cwd }` option). */
	cwd: string | undefined;
	/** The render's `useModel` declaration; exactly one per render. */
	model: string | undefined;
	/** `useModel` options: default reasoning effort. */
	thinkingLevel: ThinkingLevel | undefined;
	/** `useModel` options: threshold-compaction configuration. */
	compaction: false | CompactionConfig | undefined;
	/** `useSkill` mounts across the whole render, in call order; names unique. */
	skills: Skill[];
	/** `useSubagent` declarations across the whole render, in call order; names unique. */
	subagents: SubagentDefinition[];
	/** `useMcpConnection` declarations across the whole render, in call order; names unique. */
	mcpConnections: McpConnectionDefinition[];
	state: RenderStateContext | undefined;
}

let currentFrame: RenderFrame | undefined;

/** Whether an agent render is currently on the stack (setters must throw then). */
export function isRendering(): boolean {
	return currentFrame !== undefined;
}

/** Resolve the active render frame, or throw the outside-render error. */
export function requireRenderFrame(hookName: string): RenderFrame {
	if (!currentFrame) {
		throw new Error(
			`[flue] ${hookName}() was called outside an agent function. ` +
				'Flue Hooks compose an agent while it renders: call them synchronously in the agent function body (or in a custom hook it calls), not from tools, actions, event handlers, or module scope.',
		);
	}
	return currentFrame;
}

/** Run one synchronous render inside a fresh frame; always clears the slot. */
export function renderWithFrame<T>(
	render: () => T,
	state?: RenderStateContext,
	kind: RenderFrame['kind'] = 'agent',
): { result: T; frame: RenderFrame } {
	if (currentFrame) {
		throw new Error(
			'[flue] Re-entrant agent render. An agent function must not invoke another agent function directly; compose shared behavior with custom hooks instead.',
		);
	}
	const frame: RenderFrame = {
		kind,
		instructions: [],
		tools: [],
		stateNames: new Set(),
		messageDataNames: new Set(),
		responseStarts: [],
		responseFinishes: [],
		agentStarts: [],
		agentFinishes: [],
		sandbox: undefined,
		cwd: undefined,
		model: undefined,
		thinkingLevel: undefined,
		compaction: undefined,
		skills: [],
		subagents: [],
		mcpConnections: [],
		state,
	};
	currentFrame = frame;
	try {
		return { result: render(), frame };
	} finally {
		currentFrame = undefined;
	}
}
