import type { Delivery, Dispatch, DispatchRequest } from '../types.ts';
import type { DispatchQueue } from './dispatch-queue.ts';

export interface ExternalChannelRuntime {
	manifest?: {
		agents: Array<{
			name: string;
			channels: Record<string, true>;
		}>;
	};
	receiveHandlers?: Record<string, AgentReceiveHandler>;
	dispatchQueue?: DispatchQueue;
}

export type AgentReceiveHandler = (ctx: {
	delivery: Delivery;
	dispatch: Dispatch;
}) => unknown | Promise<unknown>;

export async function receiveExternalDelivery(
	delivery: Delivery,
	rt: ExternalChannelRuntime,
	options: { dispatchQueue?: DispatchQueue } = {},
): Promise<{ invoked: string[]; errors: Array<{ agent: string; error: unknown }> }> {
	const invoked: string[] = [];
	const errors: Array<{ agent: string; error: unknown }> = [];
	const dispatchQueue = options.dispatchQueue ?? rt.dispatchQueue ?? defaultDispatchQueue;
	for (const agent of rt.manifest?.agents ?? []) {
		if (!agent.channels[delivery.channel]) continue;
		const receive = rt.receiveHandlers?.[agent.name];
		if (!receive) {
			const error = new Error(`[flue] Agent "${agent.name}" is subscribed to "${delivery.channel}" but has no receive handler.`);
			errors.push({ agent: agent.name, error });
			console.error(error.message);
			continue;
		}
		invoked.push(agent.name);
		try {
			const deliveryForAgent = cloneJsonSerializable(delivery, 'delivery') as Delivery;
			await receive({
				delivery: deliveryForAgent,
				dispatch: createDispatchFn({
					delivery: deliveryForAgent,
					sourceAgent: agent.name,
					dispatchQueue,
					rt,
				}),
			});
		} catch (error) {
			errors.push({ agent: agent.name, error });
			console.error(`[flue:receive] Agent "${agent.name}" receive() failed:`, error);
		}
	}
	return { invoked, errors };
}

const defaultDispatchQueue: DispatchQueue = {
	async enqueue(): Promise<never> {
		throw new Error('[flue] dispatch() cannot be accepted because no dispatch queue is configured.');
	},
};

function createDispatchFn(options: {
	delivery: Delivery;
	sourceAgent: string;
	dispatchQueue: DispatchQueue;
	rt: ExternalChannelRuntime;
}): Dispatch {
	return async (request) => {
		const targetAgent = request.agent ?? options.sourceAgent;
		const input = validateAndCloneDispatchRequest(request, targetAgent, options.rt);
		await options.dispatchQueue.enqueue({
			dispatchId: crypto.randomUUID(),
			deliveryId: options.delivery.id,
			sourceAgent: options.sourceAgent,
			targetAgent,
			agent: targetAgent,
			id: request.id,
			session: request.session,
			input,
			acceptedAt: new Date().toISOString(),
		});
	};
}

function validateAndCloneDispatchRequest(
	request: DispatchRequest,
	targetAgent: string,
	rt: ExternalChannelRuntime,
): unknown {
	if (typeof targetAgent !== 'string' || targetAgent.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty target agent.');
	}
	if (typeof request.id !== 'string' || request.id.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "id" target agent instance id.');
	}
	if (typeof request.session !== 'string' || request.session.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "session" target session id.');
	}
	if (request.input === undefined) {
		throw new Error('[flue] dispatch() requires an "input" payload. Use null for an intentional empty payload.');
	}
	if (!agentExists(rt, targetAgent)) {
		throw new Error(`[flue] dispatch() target agent "${targetAgent}" is not registered.`);
	}
	return cloneJsonSerializable(request.input, 'dispatch().input');
}

function agentExists(rt: ExternalChannelRuntime, agentName: string): boolean {
	return (rt.manifest?.agents ?? []).some((agent) => agent.name === agentName);
}

function cloneJsonSerializable(value: unknown, label: string): unknown {
	assertJsonLike(value, label, new WeakSet());
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(`[flue] ${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
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
		throw new Error(`[flue] ${path} must contain only plain JSON objects, arrays, strings, numbers, booleans, or null.`);
	}
	for (const [key, child] of Object.entries(value)) {
		assertJsonLike(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}
