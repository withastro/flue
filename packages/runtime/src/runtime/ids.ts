import { ulid } from 'ulidx';

export function generateRunId(): string {
	return `run_${ulid()}`;
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}
