const EXECUTION_SHUTDOWN_TIMEOUT_MS = 5000;

/** The slice of a running execution the signal handler needs. */
export interface AbortableExecution {
	cancel(reason?: unknown): void;
	close(): Promise<void>;
	forceCloseSync(): void;
}

export interface BoundedShutdownOptions {
	close(): Promise<void>;
	forceCloseSync(): void;
	exitCode: number;
	timeoutMs?: number;
	terminate?: (code: number) => unknown;
}

export async function boundedShutdown(options: BoundedShutdownOptions): Promise<void> {
	process.exitCode = options.exitCode;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	try {
		const closing = Promise.resolve().then(() => options.close());
		void closing.catch(() => {});
		await Promise.race([
			closing,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve();
				}, options.timeoutMs ?? EXECUTION_SHUTDOWN_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (timedOut) {
			options.forceCloseSync();
			(options.terminate ?? process.exit)(options.exitCode);
		}
	}
}

export function closeExecutionForSignal(
	signal: NodeJS.Signals,
	execution: AbortableExecution,
	terminate?: (code: number) => unknown,
): Promise<void> {
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	execution.cancel();
	return boundedShutdown({
		close: () => execution.close(),
		forceCloseSync: () => execution.forceCloseSync(),
		exitCode,
		terminate,
	});
}
