import { describe, expect, it, vi } from 'vitest';
import {
	createAgent,
	SessionAlreadyExistsError,
	SessionBusyError,
	SessionDeletedError,
	SessionNotFoundError,
} from '../src/index.ts';
import { createFlueContext, type FlueContextConfig } from '../src/internal.ts';
import type { FlueEvent, SessionData, SessionEnv, SessionStore } from '../src/types.ts';

describe('FlueHarness', () => {
	it('uses the default harness name when init() receives no name', async () => {
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv(), store).init(
			createAgent(() => ({ model: false })),
		);

		expect(harness.name).toBe('default');
	});

	it('exposes sandbox filesystem operations when a harness is initialized', async () => {
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv(), store).init(
			createAgent(() => ({ model: false })),
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
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv({ exec }), store).init(
			createAgent(() => ({ model: false })),
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
		expect(store.saveCalls).toEqual([]);
	});

	it('redacts environment values from tool events when shell() receives environment variables', async () => {
		const exec = vi.fn(async () => ({ stdout: 'configured', stderr: '', exitCode: 0 }));
		const events: FlueEvent[] = [];
		const store = new TrackingSessionStore();
		const ctx = createContext(createEnv({ exec }), store);
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({ model: false })),
			{ name: 'reviewer' },
		);

		await harness.shell('printenv TOKEN', { env: { TOKEN: 'secret-value' }, cwd: '/repo' });

		expect(exec).toHaveBeenCalledWith('printenv TOKEN', {
			env: { TOKEN: 'secret-value' },
			cwd: '/repo',
			signal: expect.any(AbortSignal),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_start',
				harness: 'reviewer',
				toolName: 'bash',
				args: { command: 'printenv TOKEN', cwd: '/repo', env: { TOKEN: '<redacted>' } },
			}),
		);
		expect(JSON.stringify(events)).not.toContain('secret-value');
	});

	describe('session()', () => {
		it('gets or creates the default session when no name is provided', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			const created = await harness.session();
			const reopened = await harness.session();

			expect(created.name).toBe('default');
			expect(reopened).toBe(created);
			expect(store.peek('agent-session:["agent-instance","default","default"]')).toMatchObject({
				version: 6,
				affinityKey: expect.stringMatching(/^aff_[0-9A-HJKMNP-TV-Z]{26}$/),
				entries: [],
				leafId: null,
				taskSessions: [],
			});
		});

		it('hides internal runtime members when a session is handed to user code', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			const session = await harness.session();

			expect(Object.keys(session).sort()).toEqual([
				'compact',
				'delete',
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

		it('rejects persisted session data written by an earlier beta', async () => {
			const store = new TrackingSessionStore();
			await store.save('agent-session:["agent-instance","default","review"]', {
				version: 4,
				affinityKey: 'aff_01J00000000000000000000000',
				entries: [],
				leafId: null,
				metadata: {},
				createdAt: '2026-06-02T00:00:00.000Z',
				updatedAt: '2026-06-02T00:00:00.000Z',
			} as unknown as SessionData);
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.session('review')).rejects.toThrow(
				'Session data version 4 is unsupported. Clear persisted session state created by an earlier Flue beta.',
			);
		});

		it('rejects malformed persisted session affinity keys', async () => {
			const store = new TrackingSessionStore();
			await store.save('agent-session:["agent-instance","default","review"]', {
				version: 6,
				affinityKey: ['aff_01J00000000000000000000000'],
				entries: [],
				leafId: null,
				taskSessions: [],
				metadata: {},
				createdAt: '2026-06-02T00:00:00.000Z',
				updatedAt: '2026-06-02T00:00:00.000Z',
			} as unknown as SessionData);
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.session('review')).rejects.toThrow(
				'Session data affinity key is malformed. Clear malformed persisted session state.',
			);
		});

		it('rejects persisted session affinity keys with overflowing ULID timestamps', async () => {
			const store = new TrackingSessionStore();
			await store.save('agent-session:["agent-instance","default","review"]', {
				version: 6,
				affinityKey: 'aff_ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
				entries: [],
				leafId: null,
				taskSessions: [],
				metadata: {},
				createdAt: '2026-06-02T00:00:00.000Z',
				updatedAt: '2026-06-02T00:00:00.000Z',
			} as SessionData);
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.session('review')).rejects.toThrow(
				'Session data affinity key is malformed. Clear malformed persisted session state.',
			);
		});

		it('preserves named conversation state when a session is reopened from persistent storage', async () => {
			const exec = vi.fn(async (command: string) => ({ stdout: command, stderr: '', exitCode: 0 }));
			const store = new TrackingSessionStore();
			const firstHarness = await createContext(createEnv({ exec }), store).init(
				createAgent(() => ({ model: false })),
			);
			const firstSession = await firstHarness.session('review');
			await firstSession.shell('printf first');
			const firstRecord = store.peek('agent-session:["agent-instance","default","review"]');
			const affinityKey = firstRecord?.affinityKey;
			const preservedEntries = structuredClone(firstRecord?.entries);
			expect(affinityKey).toMatch(/^aff_[0-9A-HJKMNP-TV-Z]{26}$/);
			expect(preservedEntries).toHaveLength(3);
			const secondHarness = await createContext(createEnv({ exec }), store).init(
				createAgent(() => ({ model: false })),
			);

			const reopened = await secondHarness.sessions.get('review');
			await reopened.shell('printf second');

			const reopenedRecord = store.peek('agent-session:["agent-instance","default","review"]');
			const entries = reopenedRecord?.entries;
			expect(reopened.name).toBe('review');
			expect(reopenedRecord?.affinityKey).toBe(affinityKey);
			expect(entries).toHaveLength(6);
			expect(entries?.slice(0, 3)).toEqual(preservedEntries);
			expect(entries?.slice(3)).toEqual([
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'user' }),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'assistant' }),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'toolResult' }),
				}),
			]);
		});
	});

	describe('sessions', () => {
		it('rejects a missing session when get() targets an unknown name', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.sessions.get('missing-review')).rejects.toThrow(SessionNotFoundError);
			expect(store.peek('agent-session:["agent-instance","default","missing-review"]')).toBeNull();
		});

		it('rejects an existing session when create() targets an existing name', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);
			await harness.session('review');

			await expect(harness.sessions.create('review')).rejects.toThrow(SessionAlreadyExistsError);
		});

		it('rejects reserved task names when ordinary session APIs receive an internal session name', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.session('task:default:child')).rejects.toThrow(
				'Session names beginning with "task:" are reserved for delegated tasks',
			);
			await expect(harness.sessions.delete('task:default:child')).rejects.toThrow(
				'Session names beginning with "task:" are reserved for delegated tasks',
			);
			expect(store.saveCalls).toEqual([]);
			expect(store.deleteCalls).toEqual([]);
		});

		it('deletes stored conversation state when delete() targets an existing name', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);
			const session = await harness.session('review');
			await session.shell('printf reviewed');
			expect(
				store.peek('agent-session:["agent-instance","default","review"]')?.entries,
			).toHaveLength(3);

			await harness.sessions.delete('review');

			expect(store.peek('agent-session:["agent-instance","default","review"]')).toBeNull();
			await expect(harness.sessions.get('review')).rejects.toThrow(SessionNotFoundError);
		});

		it('allows deletion when delete() targets an unknown name', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			await expect(harness.sessions.delete('missing-review')).resolves.toBeUndefined();

			expect(store.deleteCalls).toEqual([
				'agent-session:["agent-instance","default","missing-review"]',
			]);
		});

		it('wraps store deletion in one coordinated operation when delete() targets an unopened session', async () => {
			const store = new TrackingSessionStore();
			const calls: string[] = [];
			const harness = await createContext(createEnv(), store, {
				submissionStore: {
					deleteSession: async (storageKey: string, deleteSessionTree: () => Promise<void>) => {
						calls.push(`begin:${storageKey}`);
						await deleteSessionTree();
						calls.push(`finish:${storageKey}`);
					},
				} as never,
			}).init(createAgent(() => ({ model: false })));

			await harness.sessions.delete('review');

			expect(calls).toEqual([
				'begin:agent-session:["agent-instance","default","review"]',
				'finish:agent-session:["agent-instance","default","review"]',
			]);
			expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
		});

		it('applies session management requests in order when concurrent requests target the same name', async () => {
			const store = new TrackingSessionStore();
			store.blockLoads();
			const harness = await createContext(createEnv(), store).init(
				createAgent(() => ({ model: false })),
			);

			const opened = harness.session('review');
			await store.loadStarted;
			const deleted = harness.sessions.delete('review');
			try {
				expect(store.deleteCalls).toEqual([]);
			} finally {
				store.releaseLoad();
			}

			await opened;
			await deleted;

			expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
			expect(store.peek('agent-session:["agent-instance","default","review"]')).toBeNull();
		});
	});
});

describe('FlueSession', () => {
	describe('shell()', () => {
		it('persists a shell exchange in conversation state when a command succeeds', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(
				createEnv({ exec: async () => ({ stdout: 'reviewed', stderr: '', exitCode: 0 }) }),
				store,
			).init(createAgent(() => ({ model: false })));
			const session = await harness.session('review');

			await expect(session.shell('printf reviewed')).resolves.toEqual({
				stdout: 'reviewed',
				stderr: '',
				exitCode: 0,
			});

			expect(store.peek('agent-session:["agent-instance","default","review"]')?.entries).toEqual([
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'user' }),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({
						role: 'assistant',
						content: [
							expect.objectContaining({
								type: 'toolCall',
								name: 'bash',
								arguments: { command: 'printf reviewed' },
							}),
						],
					}),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({
						role: 'toolResult',
						toolName: 'bash',
						content: [{ type: 'text', text: 'reviewed' }],
						isError: false,
					}),
				}),
			]);
		});

		it('persists an errored shell exchange in conversation state when a command fails', async () => {
			const store = new TrackingSessionStore();
			const harness = await createContext(
				createEnv({
					exec: async () => {
						throw new Error('sandbox unavailable');
					},
				}),
				store,
			).init(createAgent(() => ({ model: false })));
			const session = await harness.session('review');

			await expect(session.shell('exit 9')).rejects.toThrow('sandbox unavailable');

			expect(store.peek('agent-session:["agent-instance","default","review"]')?.entries).toEqual([
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'user' }),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({ role: 'assistant' }),
				}),
				expect.objectContaining({
					type: 'message',
					message: expect.objectContaining({
						role: 'toolResult',
						toolName: 'bash',
						content: [{ type: 'text', text: 'sandbox unavailable' }],
						details: { command: 'exit 9', exitCode: -1 },
						isError: true,
					}),
				}),
			]);
		});

		it('redacts environment values from persisted arguments when a command receives environment variables', async () => {
			const exec = vi.fn(async () => ({ stdout: 'configured', stderr: '', exitCode: 0 }));
			const store = new TrackingSessionStore();
			const harness = await createContext(createEnv({ exec }), store).init(
				createAgent(() => ({ model: false })),
			);
			const session = await harness.session('review');

			await session.shell('printenv TOKEN', { env: { TOKEN: 'secret-value' }, cwd: '/repo' });

			expect(exec).toHaveBeenCalledWith('printenv TOKEN', {
				env: { TOKEN: 'secret-value' },
				cwd: '/repo',
				signal: expect.any(AbortSignal),
			});
			expect(
				store.peek('agent-session:["agent-instance","default","review"]')?.entries[1],
			).toMatchObject({
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'toolCall',
							id: expect.any(String),
							name: 'bash',
							arguments: {
								command: 'printenv TOKEN',
								cwd: '/repo',
								env: { TOKEN: '<redacted>' },
							},
						},
					],
				},
			});
			expect(
				JSON.stringify(store.peek('agent-session:["agent-instance","default","review"]')),
			).not.toContain('secret-value');
		});
	});

	it('rejects deletion when an operation is active', async () => {
		let markExecStarted: () => void = () => {};
		const execStarted = new Promise<void>((resolve) => {
			markExecStarted = resolve;
		});
		let releaseExec: () => void = () => {};
		const execReleased = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});
		const store = new TrackingSessionStore();
		const harness = await createContext(
			createEnv({
				exec: async () => {
					markExecStarted();
					await execReleased;
					return { stdout: 'released', stderr: '', exitCode: 0 };
				},
			}),
			store,
		).init(createAgent(() => ({ model: false })));
		const session = await harness.session('review');
		const shell = session.shell('wait for review');
		await execStarted;

		try {
			await expect(session.delete()).rejects.toThrow(SessionBusyError);
			expect(store.deleteCalls).toEqual([]);
		} finally {
			releaseExec();
		}

		await shell;
		await session.delete();
		expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
	});

	it('rejects new operations when the session has been deleted', async () => {
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv(), store).init(
			createAgent(() => ({ model: false })),
		);
		const session = await harness.session('review');
		await session.delete();

		await expect(session.shell('printf late')).rejects.toThrow(SessionDeletedError);
	});

	it('wraps store deletion in one coordinated operation when an opened session is deleted', async () => {
		const store = new TrackingSessionStore();
		const calls: string[] = [];
		const harness = await createContext(createEnv(), store, {
			submissionStore: {
				deleteSession: async (storageKey: string, deleteSessionTree: () => Promise<void>) => {
					calls.push(`begin:${storageKey}`);
					await deleteSessionTree();
					calls.push(`finish:${storageKey}`);
				},
			} as never,
		}).init(createAgent(() => ({ model: false })));
		const session = await harness.session('review');

		await session.delete();

		expect(calls).toEqual([
			'begin:agent-session:["agent-instance","default","review"]',
			'finish:agent-session:["agent-instance","default","review"]',
		]);
		expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
	});

	it('shares deletion work when delete() is called concurrently', async () => {
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv(), store).init(
			createAgent(() => ({ model: false })),
		);
		const session = await harness.session('review');
		store.blockDeletes();

		const first = session.delete();
		const second = session.delete();
		await store.deleteStarted;

		try {
			expect(second).toBe(first);
			expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
		} finally {
			store.releaseDelete();
		}
		await Promise.all([first, second]);
	});

	it('resolves without repeating storage work when delete() is called after deletion completes', async () => {
		const store = new TrackingSessionStore();
		const harness = await createContext(createEnv(), store).init(
			createAgent(() => ({ model: false })),
		);
		const session = await harness.session('review');

		await session.delete();
		await expect(session.delete()).resolves.toBeUndefined();

		expect(store.deleteCalls).toEqual(['agent-session:["agent-instance","default","review"]']);
	});
});

function createContext(env: SessionEnv, store: SessionStore, overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'agent-instance',
		payload: undefined,
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => env,
		defaultStore: store,
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

class TrackingSessionStore implements SessionStore {
	private data = new Map<string, SessionData>();
	private releaseBlockedLoad: () => void = () => {};
	private releaseBlockedDelete: () => void = () => {};
	private loadReleased = Promise.resolve();
	private deleteReleased = Promise.resolve();
	private markLoadStarted: () => void = () => {};
	private markDeleteStarted: () => void = () => {};
	readonly saveCalls: string[] = [];
	readonly deleteCalls: string[] = [];
	loadStarted = Promise.resolve();
	deleteStarted = Promise.resolve();

	peek(id: string): SessionData | null {
		return this.data.get(id) ?? null;
	}

	blockLoads(): void {
		this.loadStarted = new Promise<void>((resolve) => {
			this.markLoadStarted = resolve;
		});
		this.loadReleased = new Promise<void>((resolve) => {
			this.releaseBlockedLoad = resolve;
		});
	}

	releaseLoad(): void {
		this.releaseBlockedLoad();
	}

	blockDeletes(): void {
		this.deleteStarted = new Promise<void>((resolve) => {
			this.markDeleteStarted = resolve;
		});
		this.deleteReleased = new Promise<void>((resolve) => {
			this.releaseBlockedDelete = resolve;
		});
	}

	releaseDelete(): void {
		this.releaseBlockedDelete();
	}

	async save(id: string, data: SessionData): Promise<void> {
		this.saveCalls.push(id);
		this.data.set(id, data);
	}

	async load(id: string): Promise<SessionData | null> {
		this.markLoadStarted();
		await this.loadReleased;
		return this.peek(id);
	}

	async delete(id: string): Promise<void> {
		this.deleteCalls.push(id);
		this.markDeleteStarted();
		await this.deleteReleased;
		this.data.delete(id);
	}
}
