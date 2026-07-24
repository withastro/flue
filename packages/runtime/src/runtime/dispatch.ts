import type { DeliveredMessage, DispatchReceipt, NamedAgentDispatchRequest } from '../types.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { generateSubmissionId } from './ids.ts';
import { isRegisteredAgentIdentity } from './registration.ts';
import { parseDeliveredMessage } from './schemas.ts';

export async function enqueueDispatch(options: {
	request: NamedAgentDispatchRequest;
	dispatchQueue: DispatchQueue;
}): Promise<DispatchReceipt> {
	const agent = options.request.agent;
	const message = validateDispatchRequest(options.request, agent);
	if (typeof options.request.uid === 'string' && options.request.initialData !== undefined) {
		throw new Error(
			'[flue] dispatch() cannot combine a continue condition (`uid`) with `initialData` — the condition forbids creation, so the seed could never apply.',
		);
	}
	return options.dispatchQueue.enqueue({
		submissionId: generateSubmissionId(),
		agent,
		id: options.request.id,
		message,
		...(options.request.initialData !== undefined
			? { initialData: options.request.initialData }
			: {}),
		...(options.request.uid !== undefined ? { uid: options.request.uid } : {}),
		acceptedAt: new Date().toISOString(),
	});
}

function validateDispatchRequest(
	request: NamedAgentDispatchRequest,
	agent: string,
): DeliveredMessage {
	if (typeof agent !== 'string' || agent.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty target agent.');
	}
	if (typeof request.id !== 'string' || request.id.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "id" target agent instance id.');
	}
	if (!isRegisteredAgentIdentity(agent)) {
		throw new Error(`[flue] dispatch() target agent "${agent}" is not registered.`);
	}
	return parseDeliveredMessage(request.message);
}
