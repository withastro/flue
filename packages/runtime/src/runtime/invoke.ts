import type { ActionDefinition, ActionInput, ActionInputSchema } from '../action.ts';
import {
	WorkflowAdmissionError,
	WorkflowInputSerializationError,
	WorkflowInputUnexpectedError,
	WorkflowInvocationNotConfiguredError,
	WorkflowNotDiscoveredError,
} from '../errors.ts';
import { cloneJsonSerializable } from '../json-snapshot.ts';
import type { WorkflowDefinition } from '../workflow-definition.ts';

export interface WorkflowInvocationReceipt {
	readonly runId: string;
}

export type WorkflowInvokeRequest<TWorkflow extends WorkflowDefinition> =
	TWorkflow['action'] extends ActionDefinition<infer TInput, any>
		? TInput extends ActionInputSchema
			? { readonly input: ActionInput<TWorkflow['action']> }
			: { readonly input?: never }
		: never;

interface WorkflowAdmissionInput {
	readonly workflowName: string;
	readonly input: unknown;
}

export interface WorkflowInvocationRuntime {
	workflows: ReadonlyArray<{ definition: WorkflowDefinition; name: string }>;
	admitWorkflow: (input: WorkflowAdmissionInput) => Promise<WorkflowInvocationReceipt>;
}

export async function invokeWorkflow<TWorkflow extends WorkflowDefinition>(
	workflow: TWorkflow,
	request: WorkflowInvokeRequest<TWorkflow>,
	runtime: WorkflowInvocationRuntime | undefined,
): Promise<WorkflowInvocationReceipt> {
	if (!runtime) throw new WorkflowInvocationNotConfiguredError();
	const workflowName = runtime.workflows.find((record) => record.definition === workflow)?.name;
	if (!workflowName) throw new WorkflowNotDiscoveredError();
	if (!workflow.action.input && request.input !== undefined)
		throw new WorkflowInputUnexpectedError();
	let input: unknown;
	try {
		input =
			request.input === undefined
				? undefined
				: cloneJsonSerializable(request.input, 'invoke().input');
	} catch (cause) {
		throw new WorkflowInputSerializationError({ cause });
	}
	try {
		return await runtime.admitWorkflow({ workflowName, input });
	} catch (cause) {
		if (cause instanceof WorkflowAdmissionError) throw cause;
		throw new WorkflowAdmissionError({ workflow: workflowName, cause });
	}
}
