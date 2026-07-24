export type FlueExecutionOperation =
	| { type: 'agent'; operationId: string; operationKind: 'prompt' | 'skill' | 'task' }
	| { type: 'model'; turnId: string }
	| { type: 'tool'; toolCallId: string; toolName: string }
	| { type: 'task'; taskId: string };

export interface FlueTraceCarrier {
	traceparent: string;
	tracestate?: string;
}

export interface FlueExecutionContext {
	eventContext?: import('./types.ts').FlueEventContext;
	instanceId?: string;
	submissionId?: string;
	agentName?: string;
	conversationId?: string;
	harness?: string;
	session?: string;
	operationId?: string;
	turnId?: string;
	taskId?: string;
	traceCarrier?: FlueTraceCarrier;
}

export type FlueExecutionInterceptor = <T>(
	operation: FlueExecutionOperation,
	ctx: FlueExecutionContext,
	next: () => Promise<T>,
) => Promise<T>;

const interceptors: FlueExecutionInterceptor[] = [];

export function extractTraceCarrier(headers: Headers): FlueTraceCarrier | undefined {
	const traceparent = headers.get('traceparent');
	if (!traceparent || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent))
		return undefined;
	const [, traceId, spanId] = traceparent.split('-');
	if (/^0+$/.test(traceId ?? '') || /^0+$/.test(spanId ?? '')) return undefined;
	const tracestate = headers.get('tracestate');
	if (
		tracestate &&
		(tracestate.length > 512 || !tracestate.split(',').every((entry) => entry.includes('=')))
	) {
		return { traceparent };
	}
	return { traceparent, ...(tracestate ? { tracestate } : {}) };
}

export function registerExecutionInterceptor(interceptor: FlueExecutionInterceptor): () => void {
	interceptors.push(interceptor);
	return () => {
		const index = interceptors.indexOf(interceptor);
		if (index !== -1) interceptors.splice(index, 1);
	};
}

export function interceptExecution<T>(
	operation: FlueExecutionOperation,
	ctx: FlueExecutionContext,
	next: () => Promise<T>,
): Promise<T> {
	return Promise.resolve().then(() => dispatchExecution(operation, ctx, next));
}

function dispatchExecution<T>(
	operation: FlueExecutionOperation,
	ctx: FlueExecutionContext,
	next: () => Promise<T>,
): Promise<T> {
	const registered = [...interceptors];
	let index = -1;
	const dispatch = (nextIndex: number): Promise<T> => {
		if (nextIndex <= index)
			return Promise.reject(new Error('Flue execution next() called more than once.'));
		index = nextIndex;
		const interceptor = registered[nextIndex];
		if (!interceptor) return next();
		let called = false;
		return interceptor(operation, ctx, () => {
			if (called) return Promise.reject(new Error('Flue execution next() called more than once.'));
			called = true;
			return dispatch(nextIndex + 1);
		});
	};
	return dispatch(0);
}
