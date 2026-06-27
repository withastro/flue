const TASK_SESSION_PREFIX = 'task:';
const ACTION_SCOPE_PREFIX = 'action:';
const SESSION_STORAGE_PREFIX = 'agent-session:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SessionStorageIdentity {
	instanceId: string;
	harness: string;
	session: string;
}

export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export function isTaskSessionName(name: string): boolean {
	return name.startsWith(TASK_SESSION_PREFIX);
}

export function isActionScopeName(name: string): boolean {
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
		throw new Error('[flue] Session names beginning with "action:" are reserved for Actions.');
	}
}

export function createTaskSessionName(parentSession: string, taskId: string): string {
	return `${TASK_SESSION_PREFIX}${parentSession}:${taskId}`;
}

export function createSessionStorageKey(
	instanceId: string,
	harness: string,
	session: string,
): string {
	return `${SESSION_STORAGE_PREFIX}${JSON.stringify([instanceId, harness, session])}`;
}

export function createActionScopeName(invocationId: string): string {
	return `${ACTION_SCOPE_PREFIX}${invocationId}`;
}

export function childSessionStorageKey(
	parentStorageKey: string,
	child: unknown,
): string | undefined {
	if (!child || typeof child !== 'object') return undefined;
	const parent = parseSessionStorageKey(parentStorageKey);
	if (!parent) return undefined;
	const { type, session } = child as { type?: unknown; session?: unknown };
	if (typeof session !== 'string') return undefined;
	if (type === 'task') {
		const { taskId } = child as { taskId?: unknown };
		if (
			typeof taskId !== 'string' ||
			!isUuid(taskId) ||
			session !== createTaskSessionName(parent.session, taskId)
		) {
			return undefined;
		}
		return createSessionStorageKey(parent.instanceId, parent.harness, session);
	}
	if (type === 'action') {
		const { invocationId } = child as { invocationId?: unknown };
		if (typeof invocationId !== 'string' || !isUuid(invocationId)) return undefined;
		const scope = createActionScopeName(invocationId);
		return createSessionStorageKey(parent.instanceId, `${parent.harness}:${scope}`, session);
	}
	return undefined;
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
		value.length !== 3 ||
		value.some((part) => typeof part !== 'string')
	) {
		return undefined;
	}
	return { instanceId: value[0], harness: value[1], session: value[2] };
}
