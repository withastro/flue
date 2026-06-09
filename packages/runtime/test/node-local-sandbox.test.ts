import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { createAgent } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import { local } from '../src/node/index.ts';

function createContext() {
	return createFlueContext({
		id: 'agent-instance',
		payload: undefined,
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => {
			throw new Error('unexpected default sandbox');
		},
		defaultStore: new InMemorySessionStore(),
	});
}

describe('local()', () => {
	it('uses the process working directory when local() receives no cwd', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flue-local-cwd-'));
		const previousCwd = process.cwd();
		try {
			process.chdir(directory);
			const harness = await createContext().init(
				createAgent(() => ({ model: false, sandbox: local() })),
			);

			await expect(
				harness.shell(
					`${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd())'`,
				),
			).resolves.toEqual({ stdout: await realpath(directory), stderr: '', exitCode: 0 });
		} finally {
			process.chdir(previousCwd);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('scopes a relative created-agent cwd once from the process working directory when local() receives no cwd', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flue-local-relative-agent-cwd-'));
		await mkdir(join(directory, 'workspace'));
		const previousCwd = process.cwd();
		try {
			process.chdir(directory);
			const harness = await createContext().init(
				createAgent(() => ({ model: false, sandbox: local(), cwd: 'workspace' })),
			);

			await expect(
				harness.shell(
					`${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd())'`,
				),
			).resolves.toEqual({
				stdout: await realpath(join(directory, 'workspace')),
				stderr: '',
				exitCode: 0,
			});
		} finally {
			process.chdir(previousCwd);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('uses local({ cwd }) as the base directory when a relative created-agent cwd is also configured', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flue-local-base-cwd-'));
		await mkdir(join(directory, 'workspace'));
		const harness = await createContext().init(
			createAgent(() => ({ model: false, sandbox: local({ cwd: directory }), cwd: 'workspace' })),
		);

		await expect(
			harness.shell(`${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd())'`),
		).resolves.toEqual({
			stdout: await realpath(join(directory, 'workspace')),
			stderr: '',
			exitCode: 0,
		});
		await rm(directory, { recursive: true, force: true });
	});

	it('inherits shell-essential variables but omits non-allowlisted host secrets when local() receives no env overrides', async () => {
		const previousPath = process.env.PATH;
		const previousSecret = process.env.FLUE_LOCAL_TEST_SECRET;
		process.env.PATH = '/flue-test-bin';
		process.env.FLUE_LOCAL_TEST_SECRET = 'host-secret';
		try {
			const harness = await createContext().init(
				createAgent(() => ({ model: false, sandbox: local() })),
			);

			await expect(
				harness.shell(
					`${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ PATH: process.env.PATH, secret: process.env.FLUE_LOCAL_TEST_SECRET ?? null }))'`,
				),
			).resolves.toEqual({
				stdout: JSON.stringify({ PATH: '/flue-test-bin', secret: null }),
				stderr: '',
				exitCode: 0,
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousSecret === undefined) delete process.env.FLUE_LOCAL_TEST_SECRET;
			else process.env.FLUE_LOCAL_TEST_SECRET = previousSecret;
		}
	});

	it('exposes explicit variables when local() receives env overrides', async () => {
		const harness = await createContext().init(
			createAgent(() => ({
				model: false,
				sandbox: local({ env: { FLUE_LOCAL_TEST_EXPLICIT: 'available' } }),
			})),
		);

		await expect(
			harness.shell(
				`${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.FLUE_LOCAL_TEST_EXPLICIT ?? "missing")'`,
			),
		).resolves.toEqual({ stdout: 'available', stderr: '', exitCode: 0 });
	});

	it('removes allowlisted variables when local() receives undefined overrides', async () => {
		const previousHome = process.env.HOME;
		process.env.HOME = '/flue-test-home';
		try {
			const harness = await createContext().init(
				createAgent(() => ({ model: false, sandbox: local({ env: { HOME: undefined } }) })),
			);

			await expect(
				harness.shell(
					`${JSON.stringify(process.execPath)} -e 'process.stdout.write(String(Object.hasOwn(process.env, "HOME")))'`,
				),
			).resolves.toEqual({ stdout: 'false', stderr: '', exitCode: 0 });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it('snapshots host environment values when the local sandbox is created', async () => {
		const previousHome = process.env.HOME;
		process.env.HOME = '/flue-test-home-before-init';
		try {
			const harness = await createContext().init(
				createAgent(() => ({ model: false, sandbox: local() })),
			);
			process.env.HOME = '/flue-test-home-after-init';

			await expect(
				harness.shell(
					`${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.HOME ?? "missing")'`,
				),
			).resolves.toEqual({ stdout: '/flue-test-home-before-init', stderr: '', exitCode: 0 });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it('layers per-command variables over sandbox variables when exec receives env overrides', async () => {
		const harness = await createContext().init(
			createAgent(() => ({
				model: false,
				sandbox: local({
					env: { FLUE_LOCAL_TEST_LAYER: 'sandbox', FLUE_LOCAL_TEST_BASE: 'base' },
				}),
			})),
		);

		await expect(
			harness.shell(
				`${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ layer: process.env.FLUE_LOCAL_TEST_LAYER, base: process.env.FLUE_LOCAL_TEST_BASE }))'`,
				{ env: { FLUE_LOCAL_TEST_LAYER: 'command' } },
			),
		).resolves.toEqual({
			stdout: JSON.stringify({ layer: 'command', base: 'base' }),
			stderr: '',
			exitCode: 0,
		});
	});

	it('returns stdout stderr and exit code when a local command exits nonzero', async () => {
		const harness = await createContext().init(
			createAgent(() => ({ model: false, sandbox: local() })),
		);

		await expect(
			harness.shell(
				`${JSON.stringify(process.execPath)} -e 'process.stdout.write("stdout text"); process.stderr.write("stderr text"); process.exit(7)'`,
			),
		).resolves.toEqual({ stdout: 'stdout text', stderr: 'stderr text', exitCode: 7 });
	});

	it('creates parent directories when a filesystem write targets a nested path', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flue-local-write-'));
		const harness = await createContext().init(
			createAgent(() => ({ model: false, sandbox: local({ cwd: directory }) })),
		);

		await harness.fs.writeFile('generated/nested/result.txt', 'written');

		await expect(harness.fs.readFile('generated/nested/result.txt')).resolves.toBe('written');
		await expect(harness.fs.exists('generated/nested/result.txt')).resolves.toBe(true);
		await rm(directory, { recursive: true, force: true });
	});

	it('rejects invalid env configuration when local() receives a non-record env value', async () => {
		await expect(
			createContext().init(
				createAgent(() => ({ model: false, sandbox: local({ env: true as never }) })),
			),
		).rejects.toThrow('[flue] local() `env` must be a Record<string, string | undefined>.');
	});
});
