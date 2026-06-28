import { resetProviderRuntime } from '@flue/runtime/internal';
import {
	createNodeApplicationLoader,
	type NodeApplicationLoader,
} from './node-application-loader.ts';
import { createStableNodeListener, type LoadedNodeApplication } from './node-http-listener.ts';
import type { LocalHttpRuntimeOutput } from './local-http-runtime.ts';

export interface NodeLocalRuntime {
	readonly port: number;
	readonly url: string;
	start(): Promise<void>;
	reload(): Promise<void>;
	stop(): Promise<void>;
	closeSync(): void;
}

interface NodeLocalRuntimeOptions {
	root: string;
	sourceRoot: string;
	port: number;
	temporaryLocalExposure: boolean;
	hostname?: string;
	env?: NodeJS.ProcessEnv;
	onOutput?: (output: LocalHttpRuntimeOutput) => void;
	internalDevLogs?: boolean;
	reloadTimeoutMs?: number;
	viteConfig?: import('vite').UserConfig;
	onWatchChange?: (filePath: string) => void;
	createLoader?: () => Promise<NodeApplicationLoader>;
}

export async function createNodeLocalRuntime(
	options: NodeLocalRuntimeOptions,
): Promise<NodeLocalRuntime> {
	const listener = createStableNodeListener({
		port: options.port,
		hostname: options.hostname,
		// Reflect Origin for separate-origin SPAs in local dev only. Deployed
		// node servers keep CORS as an explicit application concern.
		cors: options.temporaryLocalExposure,
	});
	let loader: NodeApplicationLoader | undefined;
	let application: LoadedNodeApplication | undefined;
	let lifecycle = Promise.resolve();
	let startPromise: Promise<void> | undefined;
	let stopPromise: Promise<void> | undefined;
	let stopped = false;

	async function loadApplication(): Promise<LoadedNodeApplication> {
		resetProviderRuntime();
		loader ??= options.createLoader
			? await options.createLoader()
			: await createNodeApplicationLoader(options);
		return loader.load();
	}

	function enqueue(operation: () => Promise<void>): Promise<void> {
		const next = lifecycle.then(operation, operation);
		lifecycle = next.catch(() => undefined);
		return next;
	}

	function start(): Promise<void> {
		if (startPromise) return startPromise;
		startPromise = enqueue(async () => {
			if (stopped) throw new Error('Node local runtime is closed.');
			await listener.listen();
			try {
				const loaded = await loadApplication();
				if (stopped) {
					await loaded.stop();
					return;
				}
				application = loaded;
				listener.install(loaded);
			} catch (error) {
				await listener.stop();
				throw error;
			}
		});
		return startPromise;
	}

	async function reloadApplication(): Promise<void> {
		if (stopped) return;
		const current = application;
		current?.pauseAdmissions();
		listener.setUnavailable('draining');
		if (current) {
			try {
				await withTimeout(current.waitForIdle(), options.reloadTimeoutMs ?? 30_000);
			} catch (error) {
				listener.setUnavailable('failed');
				throw error;
			}
			await current.stop();
			if (application === current) application = undefined;
		}
		listener.setUnavailable('loading');
		try {
			const loaded = await loadApplication();
			if (stopped) {
				await loaded.stop();
				return;
			}
			application = loaded;
			listener.install(loaded);
		} catch (error) {
			listener.setUnavailable('failed');
			throw error;
		}
	}

	return {
		get port() {
			return listener.port;
		},
		get url() {
			return listener.url;
		},
		start,
		reload() {
			return enqueue(reloadApplication);
		},
		stop() {
			if (stopPromise) return stopPromise;
			stopped = true;
			stopPromise = enqueue(async () => {
				const errors: unknown[] = [];
				application?.pauseAdmissions();
				listener.setUnavailable('draining');
				try {
					await application?.stop(30_000);
				} catch (error) {
					errors.push(error);
				}
				application = undefined;
				try {
					await loader?.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await listener.stop();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1)
					throw new AggregateError(errors, 'Node local runtime shutdown failed.');
			});
			return stopPromise;
		},
		closeSync() {
			stopped = true;
			application?.closeSync();
			listener.closeSync();
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Runtime drain timed out after ${timeoutMs}ms.`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
