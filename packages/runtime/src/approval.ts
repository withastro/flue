/**
 * Human-in-the-loop tool approval middleware for Flue.
 *
 * Wraps defineTool with an approval gate: when the model tries to invoke a
 * protected tool, execution pauses until an external system (frontend UI,
 * webhook, Slack bot) approves or rejects the action.
 *
 * Design principles:
 * - Non-invasive: works as a wrapper around existing ToolDefinition
 * - Transport-agnostic: approval resolution via callback you provide
 * - Timeout-safe: auto-reject if approval doesn't arrive within deadline
 * - Auditable: every approval decision is logged with context
 *
 * @example
 * ```ts
 * import { withApproval, createApprovalGate } from './approval';
 *
 * const gate = createApprovalGate({
 *   timeout: 300_000,
 *   onRequest: async (req) => ws.send(JSON.stringify(req)),
 * });
 *
 * const protectedRefund = withApproval(refundTool, {
 *   gate,
 *   when: (args) => args.amount > 100,
 *   reason: (args) => `Refund $${args.amount} for order #${args.orderId}`,
 * });
 *
 * // Use in agent — it's still a regular ToolDefinition
 * const agent = createAgent(() => ({
 *   tools: [protectedRefund, queryOrder],
 * }));
 *
 * // When approval arrives:
 * gate.resolve(approvalId, { action: 'approve' });
 * ```
 *
 * @module
 */

import type { ToolDefinition, ToolParameters } from './types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The decision returned by an external approver. */
export type ApprovalDecision =
	| { action: 'approve' }
	| { action: 'reject'; reason?: string }
	| { action: 'modify'; args: Record<string, any> };

/** An approval request sent to the external system. */
export interface ApprovalRequest {
	/** Unique ID for this approval request. */
	id: string;
	/** Name of the tool requesting approval. */
	tool: string;
	/** Arguments the model wants to pass to the tool. */
	args: Record<string, any>;
	/** Human-readable explanation of why this needs approval. */
	reason: string;
	/** When this request was created (ISO 8601). */
	timestamp: string;
	/** When this request will auto-reject if not resolved (ISO 8601). */
	deadline: string;
}

/** Configuration for an approval gate instance. */
export interface ApprovalGateOptions {
	/**
	 * Milliseconds to wait for a decision before auto-rejecting.
	 * Default: 300_000 (5 minutes).
	 */
	timeout?: number;
	/**
	 * Called when a tool needs approval. Your job: deliver this request
	 * to whoever can approve it (WebSocket push, Slack message, etc.).
	 */
	onRequest: (request: ApprovalRequest) => Promise<void> | void;
	/**
	 * Called when a decision is made (approve/reject/timeout).
	 * Use for audit logging.
	 */
	onDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}

/** Options for wrapping a specific tool with approval. */
export interface WithApprovalOptions {
	/** The approval gate to use. */
	gate: ApprovalGate;
	/**
	 * Predicate: only require approval when this returns true.
	 * If omitted, ALL invocations require approval.
	 */
	when?: (args: Record<string, any>) => boolean;
	/**
	 * Generate a human-readable reason for the approval request.
	 * If omitted, uses a generic message with tool name and args.
	 */
	reason?: (args: Record<string, any>) => string;
}

// ─── ApprovalGate ───────────────────────────────────────────────────────────

/**
 * An ApprovalGate manages pending approval requests and resolves them
 * when external systems respond. One gate can serve multiple tools.
 *
 * @example
 * ```ts
 * const gate = createApprovalGate({
 *   timeout: 60_000,
 *   onRequest: async (req) => ws.send(JSON.stringify(req)),
 *   onDecision: (req, decision) => auditLog.write({ ...req, decision }),
 * });
 *
 * ws.on('message', (msg) => {
 *   const { type, approvalId, decision } = JSON.parse(msg);
 *   if (type === 'approval_response') gate.resolve(approvalId, decision);
 * });
 * ```
 */
export interface ApprovalGate {
	/** Submit an approval request. Returns a promise that resolves with the decision. */
	request(tool: string, args: Record<string, any>, reason: string): Promise<ApprovalDecision>;
	/** Resolve a pending approval request by ID. */
	resolve(id: string, decision: ApprovalDecision): void;
	/** Number of currently pending approvals. */
	readonly pending: number;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
	const { timeout = 300_000, onRequest, onDecision } = options;

	const pendingMap = new Map<
		string,
		{
			request: ApprovalRequest;
			resolve: (decision: ApprovalDecision) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	return {
		get pending() {
			return pendingMap.size;
		},

		async request(tool, args, reason): Promise<ApprovalDecision> {
			const id = crypto.randomUUID();
			const now = new Date();
			const deadlineDate = new Date(now.getTime() + timeout);

			const approvalRequest: ApprovalRequest = {
				id,
				tool,
				args,
				reason,
				timestamp: now.toISOString(),
				deadline: deadlineDate.toISOString(),
			};

			return new Promise<ApprovalDecision>((resolvePromise) => {
				const timer = setTimeout(() => {
					const entry = pendingMap.get(id);
					if (entry) {
						pendingMap.delete(id);
						const decision: ApprovalDecision = {
							action: 'reject',
							reason: `Approval timed out after ${timeout / 1000}s`,
						};
						onDecision?.(approvalRequest, decision);
						resolvePromise(decision);
					}
				}, timeout);

				pendingMap.set(id, {
					request: approvalRequest,
					resolve: (decision) => {
						clearTimeout(timer);
						pendingMap.delete(id);
						onDecision?.(approvalRequest, decision);
						resolvePromise(decision);
					},
					timer,
				});

				// Notify external system (fire and forget)
				Promise.resolve(onRequest(approvalRequest)).catch((err) => {
					console.error(`[approval] Failed to deliver request: ${err}`);
				});
			});
		},

		resolve(id, decision) {
			const entry = pendingMap.get(id);
			if (!entry) {
				console.warn(`[approval] No pending approval for id=${id}`);
				return;
			}
			entry.resolve(decision);
		},
	};
}

// ─── withApproval ───────────────────────────────────────────────────────────

/**
 * Wrap a ToolDefinition with an approval gate. Returns a new ToolDefinition
 * that pauses execution until human approval is received.
 *
 * The wrapped tool is a drop-in replacement — same name, same parameters,
 * same return type. The only difference: execution may pause waiting for
 * approval.
 *
 * @example
 * ```ts
 * const protectedRefund = withApproval(refundTool, {
 *   gate,
 *   when: ({ amount }) => amount > 100,
 *   reason: ({ amount, orderId }) => `Refund $${amount} for #${orderId}`,
 * });
 * ```
 */
export function withApproval<TParams extends ToolParameters>(
	tool: ToolDefinition<TParams>,
	options: WithApprovalOptions,
): ToolDefinition<TParams> {
	const { gate, when, reason } = options;

	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,

		async execute(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
			const needsApproval = when ? when(args) : true;

			if (needsApproval) {
				const reasonText = reason
					? reason(args)
					: `Tool "${tool.name}" requires approval. Args: ${JSON.stringify(args)}`;

				const decision = await gate.request(tool.name, args, reasonText);

				switch (decision.action) {
					case 'reject':
						return `[REJECTED] Tool "${tool.name}" was not approved. ${decision.reason || ''}`.trim();

					case 'modify':
						return tool.execute(decision.args, signal);

					case 'approve':
						// Fall through to execute below
						break;
				}
			}

			return tool.execute(args, signal);
		},
	};
}
