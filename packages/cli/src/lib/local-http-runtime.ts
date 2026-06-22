import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { createServer } from 'node:net';
import {
	build,
	cloudflareViteConfigPath,
	createCloudflareViteConfig,
	viteInputDir,
} from './build.ts';
import type { BuildOptions } from './types.ts';

export interface LocalHttpRuntimeOutput {
	stream: 'stdout' | 'stderr';
	line: string;
}

export interface StartLocalHttpRuntimeOptions {
	root: string;
	sourceRoot: string;
	target: 'node' | 'cloudflare';
	output?: string;
	port?: number;
	configFile?: string;
	envFile?: string;
	env?: NodeJS.ProcessEnv;
	onOutput?: (output: LocalHttpRuntimeOutput) => void;
	onExit?: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
	readyTimeoutMs?: number;
	stopTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface LocalHttpRuntime {
	readonly target: 'node' | 'cloudflare';
	readonly port: number;
	readonly url: string;
	reload(): Promise<void>;
	stop(): Promise<void>;
	killSync(): void;
}

export interface StartBuiltLocalHttpRuntimeOptions {
	root: string;
	output: string;
	target: 'node' | 'cloudflare';
	port: number;
	env?: NodeJS.ProcessEnv;
	onOutput?: (output: LocalHttpRuntimeOutput) => void;
	onExit?: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
	readyTimeoutMs?: number;
	stopTimeoutMs?: number;
	signal?: AbortSignal;
	watch?: boolean;
	internalDevLogs?: boolean;
	cloudflareLogLevel?: 'silent' | 'info';
}

interface StartedRuntime {
	port: number;
	url: string;
	reload(): Promise<void>;
	stop(): Promise<void>;
	killSync(): void;
}

export async function startLocalHttpRuntime(
	options: StartLocalHttpRuntimeOptions,
): Promise<LocalHttpRuntime> {
	const root = path.resolve(options.root);
	const sourceRoot = path.resolve(options.sourceRoot);
	const output = path.resolve(options.output ?? path.join(root, 'dist'));
	throwIfAborted(options.signal);
	const port = options.port ?? (await selectAvailablePort());
	throwIfAborted(options.signal);
	const buildOptions: BuildOptions = {
		root,
		sourceRoot,
		output,
		target: options.target,
		mode: options.target === 'cloudflare' ? 'development' : 'build',
		log: 'silent',
		configFile: options.configFile,
		envFile: options.envFile,
		temporaryLocalExposure: true,
	};
	await build(buildOptions);
	throwIfAborted(options.signal);
	return startBuiltLocalHttpRuntime({
		...options,
		root,
		output,
		port,
		watch: false,
	});
}

export async function startBuiltLocalHttpRuntime(
	options: StartBuiltLocalHttpRuntimeOptions,
): Promise<LocalHttpRuntime> {
	const started =
		options.target === 'node'
			? await startNodeRuntime(options)
			: await startCloudflareRuntime(options);
	return { target: options.target, ...started };
}

async function startNodeRuntime(options: StartBuiltLocalHttpRuntimeOptions): Promise<StartedRuntime> {
	let child: ChildProcess | null = null;
	const spawnReady = async () => {
		throwIfAborted(options.signal);
		const next = spawn(process.execPath, [path.join(options.output, 'server.mjs')], {
			cwd: options.root,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: {
				...process.env,
				...options.env,
				PORT: String(options.port),
				FLUE_MODE: 'local',
				...(options.watch ? {} : { FLUE_INTERNAL_LOCAL_ONLY: '1' }),
				...(options.internalDevLogs ? { FLUE_INTERNAL_DEV_LOGS: '1' } : {}),
			},
		});
		child = next;
		pipeLines(next, options.onOutput);
		next.on('exit', (code, signal) => {
			if (child !== next) return;
			child = null;
			options.onExit?.({ code, signal });
		});
		try {
			await waitForNodeReady(next, options.readyTimeoutMs ?? 10_000, options.signal);
		} catch (error) {
			await stopChild(next, options.stopTimeoutMs ?? 5_000);
			if (child === next) child = null;
			throw error;
		}
	};
	await spawnReady();
	return {
		port: options.port,
		url: `http://localhost:${options.port}`,
		async reload() {
			const previous = child;
			child = null;
			if (previous) await stopChild(previous, options.stopTimeoutMs ?? 5_000);
			await spawnReady();
		},
		async stop() {
			const previous = child;
			child = null;
			if (previous) await stopChild(previous, options.stopTimeoutMs ?? 5_000);
		},
		killSync: () => {
			if (child) killChildSync(child);
		},
	};
}

async function startCloudflareRuntime(
	options: StartBuiltLocalHttpRuntimeOptions,
): Promise<StartedRuntime> {
	const [{ cloudflare }, { createServer }] = await Promise.all([
		import('@cloudflare/vite-plugin'),
		import('vite'),
	]);
	const entryPath = path.join(viteInputDir(options.root), '_entry.ts');
	const baseConfig = createCloudflareViteConfig(
		cloudflare,
		options.root,
		cloudflareViteConfigPath(options.root),
		[entryPath],
	);
	const server = await createServer({
		...baseConfig,
		logLevel: options.cloudflareLogLevel ?? 'silent',
		server: {
			host: '127.0.0.1',
			port: options.port,
			strictPort: true,
			...(options.watch ? {} : { hmr: false, watch: { ignored: ['**/*'] } }),
		},
	});
	try {
		await server.listen();
	} catch (error) {
		await server.close();
		throw error;
	}
	const url = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${options.port}`;
	return {
		port: options.port,
		url,
		reload: () => server.restart(),
		stop: () => closeWithTimeout(server.close(), options.stopTimeoutMs ?? 5_000),
		killSync() {},
	};
}

function pipeLines(
	child: ChildProcess,
	onOutput: StartLocalHttpRuntimeOptions['onOutput'],
): void {
	if (!onOutput) return;
	for (const [stream, source] of [
		['stdout', child.stdout],
		['stderr', child.stderr],
	] as const) {
		let buffered = '';
		source?.setEncoding('utf8');
		source?.on('data', (chunk: string) => {
			buffered += chunk;
			const lines = buffered.split('\n');
			buffered = lines.pop() ?? '';
			for (const line of lines) onOutput({ stream, line });
		});
		source?.on('end', () => {
			if (buffered) onOutput({ stream, line: buffered });
		});
	}
}

async function waitForNodeReady(
	child: ChildProcess,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('exit', onExit);
			child.off('error', onError);
			signal?.removeEventListener('abort', onAbort);
		};
		const onMessage = (message: unknown) => {
			if (message !== 'flue:dev-ready') return;
			cleanup();
			resolve();
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(
				new Error(
					`Node server exited before becoming ready (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for Node server to become ready.'));
		}, timeoutMs);
		child.on('message', onMessage);
		child.once('exit', onExit);
		child.once('error', onError);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		child.once('exit', done);
		const timer = setTimeout(() => {
			killChildSync(child);
			setTimeout(done, 1_000).unref();
		}, timeoutMs);
		try {
			child.kill('SIGTERM');
		} catch {
			done();
		}
	});
}

function killChildSync(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill('SIGKILL');
	} catch {}
}

async function closeWithTimeout(close: Promise<void>, timeoutMs: number): Promise<void> {
	await Promise.race([
		close,
		new Promise<void>((resolve) => {
			setTimeout(resolve, timeoutMs).unref();
		}),
	]);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function selectAvailablePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Unable to select an available local HTTP port.'));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}
