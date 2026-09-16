import { cloneJsonSerializable, type JsonValue } from '../json-snapshot.ts';
import type { DeliveredMessage, DispatchReceipt, NamedAgentDispatchRequest } from '../types.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { deriveKeyedSubmissionId, generateSubmissionId } from './ids.ts';
import { isRegisteredAgentIdentity } from './registration.ts';
import { parseDeliveredMessage, parseIdempotencyKey } from './schemas.ts';

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
	// A keyed dispatch derives its submission id from the caller's key, so a
	// redelivery re-derives the same id and converges on the original
	// admission; an unkeyed one mints a fresh identity per call.
	const idempotencyKey = options.request.idempotencyKey;
	return options.dispatchQueue.enqueue({
		submissionId:
			idempotencyKey !== undefined
				? await deriveKeyedSubmissionId(
						agent,
						options.request.id,
						parseIdempotencyKey(idempotencyKey),
					)
				: generateSubmissionId(),
		agent,
		id: options.request.id,
		message,
		...(options.request.deliveryContext !== undefined
			? {
					deliveryContext: cloneJsonSerializable(
						options.request.deliveryContext,
						'deliveryContext',
					) as JsonValue,
				}
			: {}),
		...(options.request.deliveryMode !== undefined
			? { deliveryMode: options.request.deliveryMode }
			: {}),
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
	if (request.deliveryMode !== undefined && request.deliveryMode !== 'join' && request.deliveryMode !== 'fifo') {
		throw new Error('[flue] dispatch() deliveryMode must be "join" or "fifo".');
	}
	return parseDeliveredMessage(request.message);
}
