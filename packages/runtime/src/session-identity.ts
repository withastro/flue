const TASK_SESSION_PREFIX = 'task:';
const ACTION_SCOPE_PREFIX = 'action:';
const SESSION_STORAGE_PREFIX = 'agent-session:';
interface SessionStorageIdentity {
	agentName: string;
	instanceId: string;
	harness: string;
	session: string;
}

const ULID_TAIL_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** House id convention for durable-record validators: `<prefix>_<ulid>`. */
function isPrefixedUlid(value: string, prefix: string): boolean {
	return value.startsWith(prefix) && ULID_TAIL_PATTERN.test(value.slice(prefix.length));
}

export function isDurableTaskId(value: string): boolean {
	return isPrefixedUlid(value, 'task_');
}

export function isDurableInvocationId(value: string): boolean {
	return isPrefixedUlid(value, 'inv_');
}

function isTaskSessionName(name: string): boolean {
	return name.startsWith(TASK_SESSION_PREFIX);
}

function isActionScopeName(name: string): boolean {
	return name.startsWith(ACTION_SCOPE_PREFIX);
}

export function isPublicSessionName(name: string): boolean {
	return !isTaskSessionName(name) && !isActionScopeName(name);
}

export function assertPublicSessionName(name: string): void {
	if (isTaskSessionName(name)) {
		throw new Error(
			'[flue] Session names beginning with "task:" are reserved for delegated tasks.',
		);
	}
	if (isActionScopeName(name)) {
		throw new Error(
			'[flue] Session names beginning with "action:" are reserved for invocation-scoped harness children.',
		);
	}
}

export function createTaskSessionName(parentSession: string, taskId: string): string {
	return `${TASK_SESSION_PREFIX}${parentSession}:${taskId}`;
}

/**
 * Serialize the durable session-lane identity of one agent instance's work.
 *
 * An agent instance is addressed by the (agent name, instance id) PAIR — the
 * same instance id under two different agents is two independent instances.
 * Both halves of the address are part of the key: rows fenced by this key
 * (queue ordering, session-scoped abort, attempt ownership) must never
 * conflate `alpha/shared` with `beta/shared`.
 */
export function createSessionStorageKey(
	agentName: string,
	instanceId: string,
	harness: string,
	session: string,
): string {
	return `${SESSION_STORAGE_PREFIX}${JSON.stringify([agentName, instanceId, harness, session])}`;
}

export function createActionScopeName(invocationId: string): string {
	return `${ACTION_SCOPE_PREFIX}${invocationId}`;
}

export function parseSessionStorageKey(storageKey: string): SessionStorageIdentity | undefined {
	if (!storageKey.startsWith(SESSION_STORAGE_PREFIX)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(storageKey.slice(SESSION_STORAGE_PREFIX.length));
	} catch {
		return undefined;
	}
	if (
		!Array.isArray(value) ||
		value.length !== 4 ||
		value.some((part) => typeof part !== 'string')
	) {
		// Includes pre-v7 3-element keys: behind the schema-version gate they
		// should never be read, but if one surfaces it must fail closed rather
		// than match another agent's lane.
		return undefined;
	}
	return { agentName: value[0], instanceId: value[1], harness: value[2], session: value[3] };
}
