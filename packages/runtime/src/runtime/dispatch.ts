import type { DispatchReceipt, NamedAgentDispatchRequest } from '../types.ts';
import type { DispatchQueue } from './dispatch-queue.ts';

export interface DispatchRuntime {
	manifest?: {
		agents: Array<{
			name: string;
		}>;
	};
}

export async function enqueueDispatch(options: {
	request: NamedAgentDispatchRequest;
	dispatchQueue: DispatchQueue;
	rt: DispatchRuntime;
}): Promise<DispatchReceipt> {
	const agent = options.request.agent;
	const input = validateAndCloneDispatchRequest(options.request, agent, options.rt);
	return options.dispatchQueue.enqueue({
		dispatchId: crypto.randomUUID(),
		agent,
		id: options.request.id,
		session: 'default',
		input,
		acceptedAt: new Date().toISOString(),
	});
}

function validateAndCloneDispatchRequest(
	request: NamedAgentDispatchRequest,
	agent: string,
	rt: DispatchRuntime,
): unknown {
	if (typeof agent !== 'string' || agent.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty target agent.');
	}
	if (typeof request.id !== 'string' || request.id.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "id" target agent instance id.');
	}
	if (request.input === undefined) {
		throw new Error(
			'[flue] dispatch() requires an "input" payload. Use null for an intentional empty payload.',
		);
	}
	if (!agentExists(rt, agent)) {
		throw new Error(`[flue] dispatch() target agent "${agent}" is not registered.`);
	}
	return cloneJsonSerializable(request.input, 'dispatch().input');
}

function agentExists(rt: DispatchRuntime, agentName: string): boolean {
	return (rt.manifest?.agents ?? []).some((agent) => agent.name === agentName);
}

function cloneJsonSerializable(value: unknown, label: string): unknown {
	assertJsonLike(value, label, new WeakSet());
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`[flue] ${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return JSON.parse(json) as unknown;
}

function assertJsonLike(value: unknown, path: string, seen: WeakSet<object>): void {
	if (value === null) return;
	const type = typeof value;
	if (type === 'string' || type === 'number' || type === 'boolean') {
		if (type === 'number' && !Number.isFinite(value)) {
			throw new Error(`[flue] ${path} must not contain non-finite numbers.`);
		}
		return;
	}
	if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
		throw new Error(`[flue] ${path} must not contain ${type} values.`);
	}
	if (typeof value !== 'object') return;
	if (seen.has(value)) throw new Error(`[flue] ${path} must not contain circular references.`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) assertJsonLike(value[i], `${path}[${i}]`, seen);
		seen.delete(value);
		return;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(
			`[flue] ${path} must contain only plain JSON objects, arrays, strings, numbers, booleans, or null.`,
		);
	}
	for (const [key, child] of Object.entries(value)) {
		assertJsonLike(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}
