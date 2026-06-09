import { describe, expect, it, vi } from 'vite-plus/test';

import { InvalidRequestError } from '../src/errors.ts';
import {
	createWebSocketErrorMessage,
	parseAgentWebSocketMessage,
	parseWorkflowWebSocketMessage,
} from '../src/runtime/websocket-protocol.ts';

describe('agent WebSocket protocol', () => {
	it('parses a prompt message when protocol version request id and message are valid', () => {
		expect(
			parseAgentWebSocketMessage(
				JSON.stringify({
					version: 1,
					type: 'prompt',
					requestId: 'request-1',
					message: 'Hello',
					session: 'support',
				}),
			),
		).toEqual({
			version: 1,
			type: 'prompt',
			requestId: 'request-1',
			message: 'Hello',
			session: 'support',
		});
	});

	it('parses a ping message when protocol version and type are valid', () => {
		expect(
			parseAgentWebSocketMessage(
				JSON.stringify({ version: 1, type: 'ping', requestId: 'request-1' }),
			),
		).toEqual({ version: 1, type: 'ping', requestId: 'request-1' });
	});

	it('rejects invalid JSON text when an agent WebSocket message cannot be parsed', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage('{');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'WebSocket messages must be valid JSON objects.',
			status: 400,
		});
	});

	it('rejects valid non-object JSON when an agent WebSocket message is an array', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify([]));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'WebSocket messages must be valid JSON objects.',
			status: 400,
		});
	});

	it('rejects valid non-object JSON when an agent WebSocket message is a scalar', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify('prompt'));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'WebSocket messages must be valid JSON objects.',
			status: 400,
		});
	});

	it('rejects valid non-object JSON when an agent WebSocket message is null', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify(null));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'WebSocket messages must be valid JSON objects.',
			status: 400,
		});
	});

	it('rejects an unsupported protocol version when an agent WebSocket message has an unknown version', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(
				JSON.stringify({ version: 2, type: 'prompt', requestId: 'request-1', message: 'Hello' }),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket messages must use protocol version 1 and type "prompt" or "ping".',
			status: 400,
		});
	});

	it('rejects an unsupported message type when an agent WebSocket message has an unknown type', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify({ version: 1, type: 'invoke' }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket messages must use protocol version 1 and type "prompt" or "ping".',
			status: 400,
		});
	});

	it('rejects a whitespace-only request id when an agent WebSocket prompt supplies a blank correlation id', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(
				JSON.stringify({ version: 1, type: 'prompt', requestId: '   ', message: 'Hello' }),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket prompt messages require string requestId and message values.',
			status: 400,
		});
	});

	it('rejects an empty session when an agent WebSocket prompt supplies a blank session', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(
				JSON.stringify({
					version: 1,
					type: 'prompt',
					requestId: 'request-1',
					message: 'Hello',
					session: '   ',
				}),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket prompt session must be a non-empty string when provided.',
			status: 400,
		});
	});

	it('rejects a reserved task session name when an agent WebSocket prompt supplies a session', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(
				JSON.stringify({
					version: 1,
					type: 'prompt',
					requestId: 'request-1',
					message: 'Hello',
					session: 'task:default:child',
				}),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details:
				'Agent WebSocket prompt session names beginning with "task:" are reserved for delegated tasks.',
			status: 400,
		});
	});

	it('rejects a whitespace-only request id when an agent WebSocket ping supplies a blank correlation id', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify({ version: 1, type: 'ping', requestId: '   ' }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket ping requestId must be a string when provided.',
			status: 400,
		});
	});

	it('rejects a ping requestId when it is present but not a string', () => {
		let thrown: unknown;
		try {
			parseAgentWebSocketMessage(JSON.stringify({ version: 1, type: 'ping', requestId: 1 }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details: 'Agent WebSocket ping requestId must be a string when provided.',
			status: 400,
		});
	});
});

describe('workflow WebSocket protocol', () => {
	it('parses an invocation message when protocol version type and request id are valid', () => {
		expect(
			parseWorkflowWebSocketMessage(
				JSON.stringify({
					version: 1,
					type: 'invoke',
					requestId: 'request-1',
					payload: { topic: 'support' },
				}),
			),
		).toEqual({
			version: 1,
			type: 'invoke',
			requestId: 'request-1',
			payload: { topic: 'support' },
		});
	});

	it('defaults workflow payload to an empty object when an invocation omits payload', () => {
		expect(
			parseWorkflowWebSocketMessage(
				JSON.stringify({ version: 1, type: 'invoke', requestId: 'request-1' }),
			),
		).toEqual({ version: 1, type: 'invoke', requestId: 'request-1', payload: {} });
	});

	it('rejects a whitespace-only request id when a workflow WebSocket invocation supplies a blank correlation id', () => {
		let thrown: unknown;
		try {
			parseWorkflowWebSocketMessage(
				JSON.stringify({ version: 1, type: 'invoke', requestId: '   ' }),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details:
				'Workflow WebSocket messages require protocol version 1, type "invoke", and a string requestId.',
			status: 400,
		});
	});

	it('rejects malformed invocation messages when required workflow fields are absent', () => {
		let thrown: unknown;
		try {
			parseWorkflowWebSocketMessage(JSON.stringify({ version: 1, type: 'invoke' }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: 'invalid_request',
			message: 'Request is malformed.',
			details:
				'Workflow WebSocket messages require protocol version 1, type "invoke", and a string requestId.',
			status: 400,
		});
	});
});

describe('WebSocket error frames', () => {
	it('includes request identity when a request-scoped WebSocket error is rendered', () => {
		expect(
			createWebSocketErrorMessage(
				new InvalidRequestError({ reason: 'Prompt request is malformed.' }),
				'request-1',
			),
		).toEqual({
			version: 1,
			type: 'error',
			requestId: 'request-1',
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details: 'Prompt request is malformed.',
			},
		});
	});

	it('includes run identity when a workflow-run-scoped WebSocket error is rendered', () => {
		expect(
			createWebSocketErrorMessage(
				new InvalidRequestError({ reason: 'Workflow request is malformed.' }),
				'request-1',
				'run-1',
			),
		).toEqual({
			version: 1,
			type: 'error',
			requestId: 'request-1',
			runId: 'run-1',
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details: 'Workflow request is malformed.',
			},
		});
	});

	it('hides internal failure details when an unknown WebSocket error is rendered', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(createWebSocketErrorMessage(new Error('database password leaked'))).toEqual({
				version: 1,
				type: 'error',
				requestId: undefined,
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
		} finally {
			consoleError.mockRestore();
		}
	});
});
