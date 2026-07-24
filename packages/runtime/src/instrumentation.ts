import { AsyncLocalStorage } from 'node:async_hooks';
import { InstrumentationAlreadyInstalledError, isDevMode } from './errors.ts';
import type { FlueExecutionInterceptor } from './execution-interceptor.ts';
import { registerExecutionInterceptor } from './execution-interceptor.ts';
import type { FlueObservationSubscriber } from './observation.ts';
import { observe } from './runtime/events.ts';

export interface FlueInstrumentation {
	key?: symbol;
	observe: FlueObservationSubscriber;
	interceptor: FlueExecutionInterceptor;
	dispose(): void | Promise<void>;
}

const installed = new WeakMap<object, () => Promise<void>>();
const installedKeys = new Map<symbol, object>();
interface InstrumentationOwnerRegistration extends InstrumentationOwner {
	add(dispose: () => Promise<void>): void;
}

const ownerStorage = new AsyncLocalStorage<InstrumentationOwnerRegistration>();

export interface InstrumentationOwner {
	dispose(): Promise<void>;
}

export function createInstrumentationOwner(): InstrumentationOwner {
	const disposers = new Set<() => Promise<void>>();
	let disposePromise: Promise<void> | undefined;
	let disposed = false;
	const owner: InstrumentationOwnerRegistration = {
		dispose() {
			disposed = true;
			disposePromise ??= Promise.allSettled(
				[...disposers].reverse().map((dispose) => dispose()),
			).then((results) => {
				const errors = results
					.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
					.map((result) => result.reason);
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) {
					throw new AggregateError(errors, '[flue] Instrumentation disposal failed.');
				}
			});
			return disposePromise;
		},
		add(dispose) {
			if (disposed) {
				void dispose().catch(() => undefined);
				return;
			}
			disposers.add(dispose);
		},
	};
	return owner;
}

export function runWithInstrumentationOwner<T>(owner: InstrumentationOwner, fn: () => T): T {
	return ownerStorage.run(owner as InstrumentationOwnerRegistration, fn);
}

export function instrument(instrumentation: FlueInstrumentation): () => Promise<void> {
	const existing = installed.get(instrumentation);
	if (existing) return existing;
	const key = instrumentation.key;
	if (key && installedKeys.has(key)) {
		// In production a keyed double-install is a programming error. Under a
		// dev module reload, user module scope (`instrument(...)` in `app.ts`)
		// re-evaluates against a runtime module instance that persisted — most
		// relevantly inside workerd, where the generated entry's static-import
		// hoisting leaves no seam to dispose the prior install first (Node dev
		// disposes through the bootstrap's instrumentation owner instead).
		// Hot-reload semantics: the newest install wins, the prior one disposes.
		if (!isDevMode()) throw new InstrumentationAlreadyInstalledError();
		const previous = installedKeys.get(key);
		installedKeys.delete(key);
		const disposePrevious = previous ? installed.get(previous) : undefined;
		if (disposePrevious) void disposePrevious().catch(() => undefined);
	}
	if (key) installedKeys.set(key, instrumentation);
	let stopObserving: () => void;
	let stopIntercepting: () => void;
	try {
		stopObserving = observe(instrumentation.observe);
		stopIntercepting = registerExecutionInterceptor(instrumentation.interceptor);
	} catch (error) {
		if (key) installedKeys.delete(key);
		throw error;
	}
	let disposePromise: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		disposePromise ??= Promise.resolve().then(async () => {
			stopObserving();
			stopIntercepting();
			try {
				await instrumentation.dispose();
			} finally {
				installed.delete(instrumentation);
				if (key && installedKeys.get(key) === instrumentation) installedKeys.delete(key);
			}
		});
		return disposePromise;
	};
	installed.set(instrumentation, dispose);
	ownerStorage.getStore()?.add(dispose);
	return dispose;
}
