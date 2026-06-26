import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent, IMAGE_DATA_OMITTED } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const IMAGE_BYTES = 'aGVsbG8taW1hZ2UtYnl0ZXM=';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `session-event-images-test-${crypto.randomUUID()}`,
		models: [{ id: 'reviewer' }],
	});
	providers.push(provider);
	return provider;
}

function createContext(provider: FauxProviderRegistration) {
	return createFlueContext({
		id: 'session-event-images-instance',
		env: {},
		agentConfig: {
			resolveModel: (specifier) => {
				if (!specifier) return undefined;
				return provider.getModel(specifier.slice(specifier.indexOf('/') + 1));
			},
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
	});
}

describe('session event image redaction', () => {
	it('omits prompt image bytes from message and agent events when a prompt includes an image', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Described the image.')]);
		const events: FlueEvent[] = [];
		const ctx = createContext(provider);
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Describe this image.', {
			images: [{ type: 'image', data: IMAGE_BYTES, mimeType: 'image/png' }],
		});

		expect(JSON.stringify(events)).not.toContain(IMAGE_BYTES);
		const userMessageEnd = events
			.filter(
				(event): event is Extract<FlueEvent, { type: 'message_end' }> =>
					event.type === 'message_end',
			)
			.map((event) => event.message)
			.find(
				(message): message is Extract<AgentMessage, { role: 'user' }> => message.role === 'user',
			);
		expect(userMessageEnd?.content).toContainEqual(
			expect.objectContaining({ type: 'image', data: IMAGE_DATA_OMITTED, mimeType: 'image/png' }),
		);
		const agentEnd = events.find(
			(event): event is Extract<FlueEvent, { type: 'agent_end' }> => event.type === 'agent_end',
		);
		const agentEndUserMessage = agentEnd?.messages.find(
			(message): message is Extract<AgentMessage, { role: 'user' }> => message.role === 'user',
		);
		expect(agentEndUserMessage?.content).toContainEqual(
			expect.objectContaining({ type: 'image', data: IMAGE_DATA_OMITTED, mimeType: 'image/png' }),
		);
	});

	it('omits image bytes from turn_request input when the model context contains an image', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Described the image.')]);
		const events: FlueEvent[] = [];
		const ctx = createContext(provider);
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Describe this image.', {
			images: [{ type: 'image', data: IMAGE_BYTES, mimeType: 'image/png' }],
		});

		const turnRequest = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
				event.type === 'turn_request',
		);
		const userInput = turnRequest?.request.input.messages.find((message) => message.role === 'user');
		expect(userInput?.content).toContainEqual({
			type: 'image',
			data: IMAGE_DATA_OMITTED,
			mimeType: 'image/png',
		});
		expect(JSON.stringify(turnRequest)).not.toContain(IMAGE_BYTES);
	});

	it('omits adapter tool-result image bytes from tool and turn_messages events when a tool returns an image', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('screenshot', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Reviewed the screenshot.'),
		]);
		const events: FlueEvent[] = [];
		const ctx = createContext(provider);
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				sandbox: {
					createSessionEnv: async () => createNoopSessionEnv(),
					tools: () => [
						{
							name: 'screenshot',
							label: 'Screenshot',
							description: 'Capture a screenshot.',
							parameters: { type: 'object', properties: {} },
							execute: async () => ({
								content: [{ type: 'image' as const, data: IMAGE_BYTES, mimeType: 'image/png' }],
								details: {},
							}),
						},
					],
				},
			})),
		);
		const session = await harness.session();

		await session.prompt('Take a screenshot.');

		expect(JSON.stringify(events)).not.toContain(IMAGE_BYTES);
		const toolCall = events.find(
			(event): event is Extract<FlueEvent, { type: 'tool' }> =>
				event.type === 'tool' && event.toolName === 'screenshot',
		);
		expect((toolCall?.result as { content?: unknown[] } | undefined)?.content).toEqual([
			{ type: 'image', data: IMAGE_DATA_OMITTED, mimeType: 'image/png' },
		]);
		const turnEnd = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_messages' }> =>
				event.type === 'turn_messages' && event.toolResults.length > 0,
		);
		const toolResultMessage = turnEnd?.toolResults.find(
			(message): message is Extract<AgentMessage, { role: 'toolResult' }> =>
				message.role === 'toolResult',
		);
		expect(toolResultMessage?.content).toContainEqual(
			expect.objectContaining({ type: 'image', data: IMAGE_DATA_OMITTED }),
		);
	});

	it('sends real image bytes to the provider and persists them in session history when events are redacted', async () => {
		const provider = createProvider();
		let providerMessages: unknown[] = [];
		provider.setResponses([
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage('Described the image.');
			},
		]);
		const events: FlueEvent[] = [];
		const ctx = createContext(provider);
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Describe this image.', {
			images: [{ type: 'image', data: IMAGE_BYTES, mimeType: 'image/png' }],
		});

		expect(JSON.stringify(events)).not.toContain(IMAGE_BYTES);
		expect(providerMessages).toContainEqual(
			expect.objectContaining({
				role: 'user',
				content: expect.arrayContaining([
					expect.objectContaining({ type: 'image', data: IMAGE_BYTES, mimeType: 'image/png' }),
				]),
			}),
		);
	});

	it('keeps real tool-result image bytes in the next provider request when tool events are redacted', async () => {
		const provider = createProvider();
		let secondTurnMessages: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('screenshot', {}), { stopReason: 'toolUse' }),
			(context) => {
				secondTurnMessages = context.messages;
				return fauxAssistantMessage('Reviewed the screenshot.');
			},
		]);
		const events: FlueEvent[] = [];
		const ctx = createContext(provider);
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				sandbox: {
					createSessionEnv: async () => createNoopSessionEnv(),
					tools: () => [
						{
							name: 'screenshot',
							label: 'Screenshot',
							description: 'Capture a screenshot.',
							parameters: { type: 'object', properties: {} },
							execute: async () => ({
								content: [{ type: 'image' as const, data: IMAGE_BYTES, mimeType: 'image/png' }],
								details: {},
							}),
						},
					],
				},
			})),
		);
		const session = await harness.session();

		await session.prompt('Take a screenshot.');

		expect(JSON.stringify(events)).not.toContain(IMAGE_BYTES);
		expect(secondTurnMessages).toContainEqual(
			expect.objectContaining({
				role: 'toolResult',
				content: expect.arrayContaining([
					expect.objectContaining({ type: 'image', data: IMAGE_BYTES, mimeType: 'image/png' }),
				]),
			}),
		);
	});
});
