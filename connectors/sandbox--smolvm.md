---
{
  "category": "sandbox",
  "website": "https://smolmachines.com",
  "aliases": ["smolvm-embedded"]
}
---

# Add a Flue Connector: smolvm

You are an AI coding agent installing the [smolvm](https://smolmachines.com) sandbox
connector for a Flue project. Follow these instructions exactly. Confirm with the
user only when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized smolvm `Machine` (from the `smolvm-embedded` SDK)
into Flue's `SandboxFactory` interface. The user owns the machine lifecycle;
this connector just adapts the running machine so Flue agents can run shell
commands and read/write files inside it.

smolvm runs **locally** via libkrun (Hypervisor.framework on macOS, KVM on
Linux). There is no remote provider to authenticate with. Because a real
hypervisor is required, this connector only works on macOS or Linux hosts and
is not suitable for edge runtimes (Cloudflare Workers, Vercel Edge, etc.) or
most managed PaaS platforms.

The `smolvm-embedded` SDK is currently alpha. One known caveat worth telling
the user about: machines created via the embedded SDK are not visible to the
`smolvm` CLI (`smolvm machine ls` won't list them). See the
[upstream README](https://github.com/smol-machines/smolvm/tree/main/sdks)
for current status.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/smolvm.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/smolvm.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract, and the shell quoting in particular is load-bearing.

```ts
/**
 * smolvm connector for Flue.
 *
 * Wraps an already-initialized smolvm Machine (from smolvm-embedded) into
 * Flue's SandboxFactory interface. The user owns the machine lifecycle.
 *
 * Every shell command is wrapped as `["sh", "-lc", cmd]` because the
 * smolvm embedded SDK's `exec` takes an argv array, not a shell string.
 * The guest image must have `sh` on PATH — true of alpine, ubuntu,
 * debian, node:*, python:*, and nearly every standard OCI image.
 *
 * @example
 * ```ts
 * import { Machine } from 'smolvm-embedded';
 * import { smolvm } from './connectors/smolvm';
 *
 * const machine = await Machine.create({ name: 'my-flue-vm' });
 * const agent = await init({
 *   sandbox: smolvm(machine),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Machine } from 'smolvm-embedded';

/**
 * Quote a string for safe inclusion in a `sh -lc` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements SandboxApi by delegating to the smolvm-embedded Machine.
 *
 * File operations use the native `readFile` / `writeFile` where available.
 * Directory operations fall back to POSIX shell commands via `exec()`.
 */
class SmolvmSandboxApi implements SandboxApi {
	constructor(private machine: Machine) {}

	async readFile(path: string): Promise<string> {
		const buf = await this.machine.readFile(path);
		return buf.toString('utf-8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		// Node Buffer is a Uint8Array subclass — return it directly.
		return this.machine.readFile(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.machine.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const r = await this.exec(`stat -c '%F|%s|%Y' ${shellQuote(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:smolvm] stat ${path}: ${r.stderr}`);
		const [type = '', size = '0', mtime = '0'] = r.stdout.trim().split('|');
		return {
			isFile: type.startsWith('regular'),
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size: Number.parseInt(size, 10) || 0,
			mtime: new Date((Number.parseInt(mtime, 10) || 0) * 1000),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const r = await this.exec(`ls -A1 ${shellQuote(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:smolvm] readdir ${path}: ${r.stderr}`);
		return r.stdout.split('\n').filter(Boolean);
	}

	async exists(path: string): Promise<boolean> {
		return (await this.exec(`test -e ${shellQuote(path)}`)).exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const r = await this.exec(
			`mkdir ${options?.recursive ? '-p ' : ''}${shellQuote(path)}`,
		);
		if (r.exitCode !== 0) throw new Error(`[flue:smolvm] mkdir ${path}: ${r.stderr}`);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const r = await this.exec(`rm ${flags ? `-${flags} ` : ''}${shellQuote(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:smolvm] rm ${path}: ${r.stderr}`);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// smolvm's `exec` takes argv (no shell parsing), so wrap in `sh -lc`
		// so users can pass shell commands the way Flue's other connectors
		// accept them. The SDK takes timeout in seconds, matching Flue's spec.
		const result = await this.machine.exec(['sh', '-lc', command], {
			workdir: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized smolvm Machine.
 * The user owns the machine lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function smolvm(machine: Machine): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? '/workspace';
			const api = new SmolvmSandboxApi(machine);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This connector imports from `smolvm-embedded`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install smolvm-embedded
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

`smolvm-embedded` resolves and installs the correct host-platform package
automatically. The smolvm CLI is **not** required for this connector.

## Required runtime

The host running the agent must be one of the platforms libkrun supports:

- **macOS 11+** on Apple Silicon (arm64) or Intel (x86_64)
- **Linux** on aarch64 or x86_64 with `/dev/kvm` accessible by the user

For local development and most Linux CI runners (including GitHub Actions
hosted runners with KVM enabled) this works out of the box. It will not run
in Cloudflare Workers, Vercel Edge, or other JS-only edge runtimes.

By default smolvm machines have **no network access**. If the user's workload
needs outbound network (package installs, API calls from inside the VM, etc.),
pass `resources: { network: true }` to `Machine.create({ ... })` and remind
them to consider the security implications — smolvm's network-off default is
intentional.

## Authentication

smolvm runs entirely locally and requires no authentication. There is no API
key, token, or login to configure.

## Provisioning the machine

The connector adapts an existing machine. Create or connect to one with the
embedded SDK before wiring it into Flue:

```ts
import { Machine } from 'smolvm-embedded';

// Fresh machine — auto-starts unless `persistent: true` is set
const machine = await Machine.create({ name: 'my-flue-vm' });

// Or connect to an already-running machine
const machine = await Machine.connect('my-flue-vm');
```

The user owns the machine's lifetime. Stop or delete it explicitly when
done:

```ts
await machine.stop();    // graceful shutdown, storage preserved
await machine.delete();  // stop + remove all storage
```

The connector **never** calls `delete()` on the user's behalf.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { Machine } from 'smolvm-embedded';
import { smolvm } from '../connectors/smolvm'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  const machine = await Machine.create({ name: `flue-${Date.now()}` });

  const agent = await init({
    sandbox: smolvm(machine),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

Tip: cold starts are sub-second, but image pulls aren't. If the user runs many
short-lived agents off the same image, point them at a long-lived
`Machine.create({ name, persistent: true })` and reuse it via `Machine.connect`
so the OCI layer cache stays warm. For one-shot work, `withMachine` from
`smolvm-embedded` handles create-and-delete around a callback.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `smolvm-embedded` (if you didn't),
   confirm they are on a macOS or Linux host with hypervisor support, and
   run `flue dev` (or `flue run <agent>`) to try it.
