import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent, Type } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { FlueEvent, SessionEnv, SessionStore } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const REDACTED_IMAGE_DATA = '[image bytes omitted from event]';
const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `event-images-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createContext(
	provider: FauxProviderRegistration,
	events: FlueEvent[],
	options: { env?: SessionEnv; store?: SessionStore } = {},
) {
	const ctx = createFlueContext({
		id: 'event-images-instance',
		payload: {},
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => options.env ?? createNoopSessionEnv(),
		defaultStore: options.store ?? new InMemorySessionStore(),
	});
	ctx.setEventCallback((event) => {
		events.push(event);
	});
	return ctx;
}

describe('session image events', () => {
	it('omits prompt image bytes from observable events when prompt() includes images', async () => {
		const provider = createProvider();
		const events: FlueEvent[] = [];
		const imageData = 'raw-prompt-image-base64';
		provider.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(imageData);
				return fauxAssistantMessage('Reviewed image.');
			},
		]);
		const harness = await createContext(provider, events).init(
			createAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		await session.prompt('Review this image.', {
			images: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
		});

		expect(JSON.stringify(events)).not.toContain(imageData);
		expect(JSON.stringify(events)).toContain(REDACTED_IMAGE_DATA);
		expect(JSON.stringify(events)).toContain('image/png');
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
					event.type === 'turn_request',
			)?.input.messages[0],
		).toMatchObject({
			role: 'user',
			content: [
				{ type: 'text', text: 'Review this image.' },
				{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/png' },
			],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'message_start' }> =>
					event.type === 'message_start' && event.message.role === 'user',
			)?.message,
		).toMatchObject({
			role: 'user',
			content: [
				{ type: 'text', text: 'Review this image.' },
				{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/png' },
			],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'message_end' }> =>
					event.type === 'message_end' && event.message.role === 'user',
			)?.message,
		).toMatchObject({
			role: 'user',
			content: [
				{ type: 'text', text: 'Review this image.' },
				{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/png' },
			],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'agent_end' }> =>
					event.type === 'agent_end',
			)?.messages[0],
		).toMatchObject({
			role: 'user',
			content: [
				{ type: 'text', text: 'Review this image.' },
				{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/png' },
			],
		});
	});

	it('omits connector tool-result image bytes from observable events when a tool returns images', async () => {
		const provider = createProvider();
		const events: FlueEvent[] = [];
		const imageData = 'raw-tool-result-image-base64';
		const captureTool: AgentTool<any> = {
			name: 'capture',
			label: 'Capture Image',
			description: 'Returns an image.',
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: 'image', data: imageData, mimeType: 'image/jpeg' }],
				details: { captured: true },
			}),
		};
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('capture', {}, { id: 'capture-call' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(imageData);
				return fauxAssistantMessage('Captured image.');
			},
		]);
		const harness = await createContext(provider, events).init(
			createAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				sandbox: {
					createSessionEnv: async () => createNoopSessionEnv(),
					tools: () => [captureTool],
				},
			})),
		);
		const session = await harness.session();

		await session.prompt('Capture an image.');

		expect(JSON.stringify(events)).not.toContain(imageData);
		expect(JSON.stringify(events)).toContain(REDACTED_IMAGE_DATA);
		expect(JSON.stringify(events)).toContain('image/jpeg');
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'tool_call' }> =>
					event.type === 'tool_call' && event.toolName === 'capture',
			)?.result,
		).toMatchObject({
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
			details: { captured: true },
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'message_start' }> =>
					event.type === 'message_start' && event.message.role === 'toolResult',
			)?.message,
		).toMatchObject({
			role: 'toolResult',
			toolName: 'capture',
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'message_end' }> =>
					event.type === 'message_end' && event.message.role === 'toolResult',
			)?.message,
		).toMatchObject({
			role: 'toolResult',
			toolName: 'capture',
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'turn_end' }> =>
					event.type === 'turn_end' && event.toolResults.length > 0,
			)?.toolResults[0],
		).toMatchObject({
			role: 'toolResult',
			toolName: 'capture',
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
					event.type === 'turn_request' &&
					event.input.messages.some((message) => message.role === 'toolResult'),
			)?.input.messages.find((message) => message.role === 'toolResult'),
		).toMatchObject({
			role: 'toolResult',
			toolName: 'capture',
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
		});
		expect(
			events.find(
				(event): event is Extract<FlueEvent, { type: 'agent_end' }> =>
					event.type === 'agent_end',
			)?.messages.find((message) => message.role === 'toolResult'),
		).toMatchObject({
			role: 'toolResult',
			toolName: 'capture',
			content: [{ type: 'image', data: REDACTED_IMAGE_DATA, mimeType: 'image/jpeg' }],
		});
	});
});
