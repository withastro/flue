import { describe, it, expect, vi } from 'vitest';
import { createApprovalGate, withApproval } from '../src/approval.ts';
import type { ToolDefinition } from '../src/types.ts';

function createMockTool(): ToolDefinition {
	return {
		name: 'process_refund',
		description: 'Process a customer refund',
		parameters: {
			type: 'object',
			properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
			required: ['orderId', 'amount'],
		},
		execute: vi.fn(async ({ orderId, amount }) =>
			JSON.stringify({ success: true, refundId: 'RF-123', orderId, amount }),
		),
	};
}

describe('createApprovalGate()', () => {
	it('creates a gate with zero pending', () => {
		const gate = createApprovalGate({ onRequest: vi.fn() });
		expect(gate.pending).toBe(0);
	});

	it('request() calls onRequest with correct structure', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });

		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' }), 10);

		const decision = await gate.request('process_refund', { amount: 500 }, 'Refund $500');
		expect(onRequest).toHaveBeenCalledTimes(1);
		const req = onRequest.mock.calls[0][0];
		expect(req.tool).toBe('process_refund');
		expect(req.args).toEqual({ amount: 500 });
		expect(req.id).toBeDefined();
		expect(req.timestamp).toBeDefined();
		expect(req.deadline).toBeDefined();
		expect(decision.action).toBe('approve');
	});

	it('resolve() approve', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' }), 10);
		expect(await gate.request('tool', {}, 'reason')).toEqual({ action: 'approve' });
		expect(gate.pending).toBe(0);
	});

	it('resolve() reject', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'reject', reason: 'Too expensive' }), 10);
		expect(await gate.request('tool', {}, 'reason')).toEqual({ action: 'reject', reason: 'Too expensive' });
	});

	it('resolve() modify', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'modify', args: { amount: 50 } }), 10);
		expect(await gate.request('tool', { amount: 500 }, 'reason')).toEqual({ action: 'modify', args: { amount: 50 } });
	});

	it('times out and auto-rejects', async () => {
		const gate = createApprovalGate({ onRequest: vi.fn(), timeout: 50 });
		const decision = await gate.request('tool', {}, 'reason');
		expect(decision.action).toBe('reject');
		expect((decision as any).reason).toContain('timed out');
	});

	it('calls onDecision on approve', async () => {
		const onRequest = vi.fn();
		const onDecision = vi.fn();
		const gate = createApprovalGate({ onRequest, onDecision });
		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' }), 10);
		await gate.request('tool', {}, 'reason');
		expect(onDecision).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'tool' }),
			{ action: 'approve' },
		);
	});

	it('calls onDecision on timeout', async () => {
		const onDecision = vi.fn();
		const gate = createApprovalGate({ onRequest: vi.fn(), onDecision, timeout: 30 });
		await gate.request('tool', {}, 'reason');
		expect(onDecision).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'tool' }),
			expect.objectContaining({ action: 'reject' }),
		);
	});

	it('resolve unknown id warns', () => {
		const gate = createApprovalGate({ onRequest: vi.fn() });
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		gate.resolve('nonexistent', { action: 'approve' });
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('No pending approval'));
		spy.mockRestore();
	});

	it('tracks pending count', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		const p1 = gate.request('t1', {}, 'r1');
		const p2 = gate.request('t2', {}, 'r2');
		const p3 = gate.request('t3', {}, 'r3');
		expect(gate.pending).toBe(3);
		gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' });
		await p1;
		expect(gate.pending).toBe(2);
		gate.resolve(onRequest.mock.calls[1][0].id, { action: 'approve' });
		gate.resolve(onRequest.mock.calls[2][0].id, { action: 'approve' });
		await Promise.all([p2, p3]);
		expect(gate.pending).toBe(0);
	});
});

describe('withApproval()', () => {
	it('preserves tool metadata', () => {
		const tool = createMockTool();
		const wrapped = withApproval(tool, { gate: createApprovalGate({ onRequest: vi.fn() }) });
		expect(wrapped.name).toBe(tool.name);
		expect(wrapped.description).toBe(tool.description);
		expect(wrapped.parameters).toBe(tool.parameters);
	});

	it('executes immediately when when() returns false', async () => {
		const tool = createMockTool();
		const onRequest = vi.fn();
		const wrapped = withApproval(tool, {
			gate: createApprovalGate({ onRequest }),
			when: ({ amount }) => amount > 100,
		});

		const result = await wrapped.execute({ orderId: 'O-1', amount: 50 });
		expect(JSON.parse(result).success).toBe(true);
		expect(onRequest).not.toHaveBeenCalled();
	});

	it('gates when when() returns true', async () => {
		const tool = createMockTool();
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		const wrapped = withApproval(tool, {
			gate,
			when: ({ amount }) => amount > 100,
			reason: ({ amount }) => `Refund $${amount}`,
		});

		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' }), 10);
		const result = await wrapped.execute({ orderId: 'O-1', amount: 500 });
		expect(JSON.parse(result).success).toBe(true);
		expect(onRequest.mock.calls[0][0].reason).toBe('Refund $500');
	});

	it('returns rejection message', async () => {
		const tool = createMockTool();
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		const wrapped = withApproval(tool, { gate });

		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'reject', reason: 'Not allowed' }), 10);
		const result = await wrapped.execute({ orderId: 'O-1', amount: 500 });
		expect(result).toContain('REJECTED');
		expect(result).toContain('Not allowed');
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('executes with modified args', async () => {
		const tool = createMockTool();
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		const wrapped = withApproval(tool, { gate });

		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'modify', args: { orderId: 'O-1', amount: 100 } }), 10);
		const result = await wrapped.execute({ orderId: 'O-1', amount: 500 });
		expect(tool.execute).toHaveBeenCalledWith({ orderId: 'O-1', amount: 100 }, undefined);
		expect(JSON.parse(result).amount).toBe(100);
	});

	it('gates all when no when() provided', async () => {
		const onRequest = vi.fn();
		const gate = createApprovalGate({ onRequest });
		const wrapped = withApproval(createMockTool(), { gate });

		setTimeout(() => gate.resolve(onRequest.mock.calls[0][0].id, { action: 'approve' }), 10);
		await wrapped.execute({ orderId: 'O-1', amount: 1 });
		expect(onRequest).toHaveBeenCalledTimes(1);
	});
});
