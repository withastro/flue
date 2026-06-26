import { describe, expect, it, vi } from 'vitest';
import {
	defineAgent,
	observe,
	SessionAlreadyExistsError,
	SessionNotFoundError,
} from '../src/index.ts';
import { createFlueContext, type FlueContextConfig } from '../src/internal.ts';
import type { FlueEvent, FlueObservation, SessionEnv } from '../src/types.ts';

describe('FlueHarness', () => {
	it('uses the default harness name when init() receives no name', async () => {
		const harness = await createContext(createEnv()).initializeRootHarness(
			defineAgent(() => ({ model: false })),
		);

		expect(harness.name).toBe('default');
	});

	it('exposes sandbox filesystem operations when a harness is initialized', async () => {
		const harness = await createContext(createEnv()).initializeRootHarness(
			defineAgent(() => ({ model: false })),
		);
		const session = await harness.session('workspace');

		await harness.fs.mkdir('drafts', { recursive: true });
		await harness.fs.writeFile('drafts/report.txt', 'reviewed');
		await session.fs.writeFile('drafts/summary.txt', new Uint8Array([100, 111, 110, 101]));

		await expect(harness.fs.readFile('drafts/report.txt')).resolves.toBe('reviewed');
		await expect(harness.fs.readFileBuffer('drafts/summary.txt')).resolves.toEqual(
			new Uint8Array([100, 111, 110, 101]),
		);
		await expect(harness.fs.stat('drafts/report.txt')).resolves.toMatchObject({
			isFile: true,
			isDirectory: false,
			size: 8,
		});
		await expect(harness.fs.readdir('drafts')).resolves.toEqual(['report.txt', 'summary.txt']);
		await expect(harness.fs.exists('drafts/report.txt')).resolves.toBe(true);

		await harness.fs.rm('drafts', { recursive: true });

		await expect(harness.fs.exists('drafts/report.txt')).resolves.toBe(false);
	});

	it('executes an out-of-band shell command when shell() is called', async () => {
		const exec = vi.fn(async () => ({ stdout: 'checked\n', stderr: '', exitCode: 0 }));
		const harness = await createContext(createEnv({ exec })).initializeRootHarness(
			defineAgent(() => ({ model: false })),
		);

		await expect(harness.shell('printf checked')).resolves.toEqual({
			stdout: 'checked\n',
			stderr: '',
			exitCode: 0,
		});
		expect(exec).toHaveBeenCalledWith('printf checked', {
			env: undefined,
			cwd: undefined,
			signal: expect.any(AbortSignal),
		});
	});

	it('redacts environment values from tool events when shell() receives environment variables', async () => {
		const exec = vi.fn(async () => ({ stdout: 'configured', stderr: '', exitCode: 0 }));
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const ctx = createContext(createEnv({ exec }));
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const stopObserving = observe((event, context) => {
			if (context === ctx) observations.push(event);
		});
		const harness = await ctx.initializeRootHarness(defineAgent(() => ({ model: false })));

		try {
			await harness.shell('printenv TOKEN', { env: { TOKEN: 'secret-value' }, cwd: '/repo' });

			expect(exec).toHaveBeenCalledWith('printenv TOKEN', {
				env: { TOKEN: 'secret-value' },
				cwd: '/repo',
				signal: expect.any(AbortSignal),
			});
			expect(observations).toContainEqual(
				expect.objectContaining({
					type: 'tool_start',
					harness: 'default',
					toolName: 'bash',
					args: { command: 'printenv TOKEN', cwd: '/repo', env: { TOKEN: '<redacted>' } },
				}),
			);
			expect(events.find((event) => event.type === 'tool_start')).not.toHaveProperty('args');
			expect(JSON.stringify(observations)).not.toContain('secret-value');
			expect(JSON.stringify(events)).not.toContain('secret-value');
		} finally {
			stopObserving();
		}
	});

	describe('session()', () => {

		it('hides internal runtime members when a session is handed to user code', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => ({ model: false })),
			);

			const session = await harness.session();

			expect(Object.keys(session).sort()).toEqual([
				'compact',
				'conversationId',
				'fs',
				'name',
				'prompt',
				'shell',
				'skill',
				'task',
			]);
			const runtimeObject = session as unknown as Record<string, unknown>;
			expect(runtimeObject.abort).toBeUndefined();
			expect(runtimeObject.close).toBeUndefined();
			expect(runtimeObject.metadata).toBeUndefined();
			expect(runtimeObject.processSubmissionInput).toBeUndefined();
		});




	});

	describe('sessions', () => {
		it('rejects a missing session when get() targets an unknown name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => ({ model: false })),
			);

			await expect(harness.sessions.get('missing-review')).rejects.toThrow(SessionNotFoundError);
		});

		it('rejects an existing session when create() targets an existing name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => ({ model: false })),
			);
			await harness.session('review');

			await expect(harness.sessions.create('review')).rejects.toThrow(SessionAlreadyExistsError);
		});

		it('rejects reserved task names when ordinary session APIs receive an internal session name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => ({ model: false })),
			);

			await expect(harness.session('task:default:child')).rejects.toThrow(
				'Session names beginning with "task:" are reserved for delegated tasks',
			);
			});
	});
});



function createContext(
	env: SessionEnv,
	overrides: Partial<FlueContextConfig> = {},
) {
	return createFlueContext({
		id: 'agent-instance',
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => env,
		...overrides,
	});
}

function createEnv(overrides: Partial<SessionEnv> = {}): SessionEnv {
	const files = new Map<string, string | Uint8Array>();
	const directories = new Set(['/repo']);
	const resolvePath = (path: string) =>
		normalizePath(path.startsWith('/') ? path : `/repo/${path}`);

	return {
		cwd: '/repo',
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			const content = files.get(resolvePath(path));
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return typeof content === 'string' ? content : new TextDecoder().decode(content);
		},
		readFileBuffer: async (path) => {
			const content = files.get(resolvePath(path));
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return typeof content === 'string' ? new TextEncoder().encode(content) : content;
		},
		writeFile: async (path, content) => {
			files.set(resolvePath(path), content);
		},
		stat: async (path) => {
			const resolved = resolvePath(path);
			const content = files.get(resolved);
			if (content === undefined && !directories.has(resolved))
				throw new Error(`missing path: ${path}`);
			return {
				isFile: content !== undefined,
				isDirectory: directories.has(resolved),
				isSymbolicLink: false,
				size:
					content === undefined
						? 0
						: typeof content === 'string'
							? new TextEncoder().encode(content).byteLength
							: content.byteLength,
				mtime: new Date(0),
			};
		},
		readdir: async (path) => {
			const resolved = resolvePath(path);
			const prefix = resolved === '/' ? '/' : `${resolved}/`;
			const entries = new Set<string>();
			for (const entry of [...directories, ...files.keys()]) {
				if (!entry.startsWith(prefix)) continue;
				const name = entry.slice(prefix.length).split('/')[0];
				if (name) entries.add(name);
			}
			return [...entries].sort();
		},
		exists: async (path) => {
			const resolved = resolvePath(path);
			return files.has(resolved) || directories.has(resolved);
		},
		mkdir: async (path) => {
			directories.add(resolvePath(path));
		},
		rm: async (path, options) => {
			const resolved = resolvePath(path);
			for (const file of files.keys()) {
				if (file === resolved || (options?.recursive && file.startsWith(`${resolved}/`))) {
					files.delete(file);
				}
			}
			for (const directory of directories) {
				if (
					directory === resolved ||
					(options?.recursive && directory.startsWith(`${resolved}/`))
				) {
					directories.delete(directory);
				}
			}
		},
		...overrides,
	};
}

function normalizePath(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}
