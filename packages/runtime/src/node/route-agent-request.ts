import {
	InvalidRequestError,
	MessageQueueFullHttpError,
	parseJsonBody,
	toHttpResponse,
} from '../errors.ts';
import { createAgentContext, type FlueContextConfig, createFlueContext } from '../client.ts';
import { MessageDispatcher, MessageQueueFullError } from '../runtime/message-dispatcher.ts';
import type { AgentModule, DeliveryInput, FlueEvent } from '../types.ts';
import { generateRunId } from '../runtime/ids.ts';

export interface NodeAgentRequestRouterOptions {
	agentModules: Record<string, AgentModule>;
	createContext(config: {
		agentName: string;
		instanceId: string;
		runId: string;
		payload: unknown;
		request: Request;
	}): FlueContextConfig;
	maxPendingMessages?: number;
}

export function createNodeAgentRequestRouter(options: NodeAgentRequestRouterOptions) {
	const dispatchers = new Map<string, MessageDispatcher>();

	return async ({
		request,
		agentName,
		instanceId,
	}: {
		request: Request;
		agentName: string;
		instanceId: string;
	}): Promise<Response> => {
		try {
			const module = options.agentModules[agentName];
			if (!module || typeof module.init !== 'function') {
				throw new Error(`[flue] Agent module "${agentName}" must export an init function.`);
			}

			const payload = await parseJsonBody(request);
			const input = normalizeHttpPayload(payload);
			const dispatcher = getOrCreateDispatcher({
				dispatchers,
				key: JSON.stringify([agentName, instanceId]),
				agentName,
				instanceId,
				module,
				request,
				payload,
				options,
			});
			const handle = await dispatcher.deliver(input);

			if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
				return streamDelivery(handle.events());
			}

			const completion = await handle.waitForIdle();
			if (completion.error !== undefined) throw completion.error;
			if (completion.result === undefined) return new Response(null, { status: 204 });
			return new Response(JSON.stringify(completion.result), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		} catch (error) {
			if (error instanceof MessageQueueFullError) {
				return toHttpResponse(new MessageQueueFullHttpError({ name: agentName, id: instanceId }));
			}
			return toHttpResponse(error);
		}
	};
}

function normalizeHttpPayload(payload: unknown): DeliveryInput {
	if (!isRecord(payload)) {
		throw new InvalidRequestError({ reason: 'JSON request bodies must be objects.' });
	}
	const { message, ...metadata } = payload;
	if (message !== undefined && typeof message !== 'string') {
		throw new InvalidRequestError({ reason: 'The top-level "message" field must be a string when provided.' });
	}
	return {
		content: message ?? '',
		metadata,
		channel: 'http',
	};
}

function getOrCreateDispatcher(input: {
	dispatchers: Map<string, MessageDispatcher>;
	key: string;
	agentName: string;
	instanceId: string;
	module: AgentModule;
	request: Request;
	payload: unknown;
	options: NodeAgentRequestRouterOptions;
}): MessageDispatcher {
	const existing = input.dispatchers.get(input.key);
	if (existing) return existing;

	let ctx = undefined as ReturnType<typeof createFlueContext> | undefined;
	const dispatcher = new MessageDispatcher({
		agentName: input.agentName,
		instanceId: input.instanceId,
		maxPendingMessages: input.options.maxPendingMessages,
		async init(message) {
			ctx = createFlueContext(
				input.options.createContext({
					agentName: input.agentName,
					instanceId: input.instanceId,
					runId: generateRunId(),
					payload: input.payload,
					request: input.request,
				}),
			);
			return input.module.init(createAgentContext(ctx, message.metadata));
		},
		onMessage: input.module.onMessage,
		async waitForIdle() {
			await ctx?.waitForIdle();
		},
	});
	input.dispatchers.set(input.key, dispatcher);
	return dispatcher;
}

function streamDelivery(events: AsyncIterable<FlueEvent>): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	void (async () => {
		try {
			for await (const event of events) {
				const payload = [`event: ${event.type}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
				await writer.write(encoder.encode(payload));
			}
		} finally {
			try {
				await writer.close();
			} catch {
			}
		}
	})();
	return new Response(readable, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
