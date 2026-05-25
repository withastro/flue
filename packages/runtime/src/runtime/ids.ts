import { ulid } from 'ulidx';

export interface WorkflowRunIdParts {
	workflowName: string;
	runNonce: string;
}

function generateRunNonce(): string {
	return ulid();
}

export function generateWorkflowRunId(workflowName: string): string {
	if (!workflowName || workflowName.includes(':')) {
		throw new Error('[flue] Workflow names used in run ids must be non-empty and must not contain ":".');
	}
	return `workflow:${workflowName}:${generateRunNonce()}`;
}

export function parseWorkflowRunId(runId: string): WorkflowRunIdParts | undefined {
	const match = /^workflow:([^:]+):([^:]+)$/.exec(runId);
	if (!match?.[1] || !match[2]) return undefined;
	return { workflowName: match[1], runNonce: match[2] };
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}

export function generateTurnId(): string {
	return `turn_${ulid()}`;
}
