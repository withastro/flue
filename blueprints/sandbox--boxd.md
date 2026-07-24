---
{
  "kind": "sandbox",
  "version": 2,
  "website": "https://boxd.sh",
  "aliases": ["@boxd-sh/sdk"]
}
---

# Add a Flue Sandbox Adapter: boxd

You are an AI coding agent installing the boxd sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized boxd VM (created with the user's own
`@boxd-sh/sdk` `Compute` client) into Flue's `SandboxFactory` interface. The
user owns the boxd VM lifecycle; this adapter just adapts the VM.

boxd ships microVMs, so each `Box` is a full Linux VM with persistent disk,
not a shared container. Cold start is sub-second and forks are even faster,
which makes it a good fit for per-session agents that want a real OS.

When the `Compute` client is passed in the adapter options (recommended —
the examples below do), the adapter also watches the VM's control-plane
status while a call is in flight and fails fast with `SandboxDiedError`
if the VM is destroyed, stopped, or failed, instead of letting the call
hang forever.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/boxd.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/boxd@2
/**
 * boxd adapter for Flue.
 *
 * Wraps an already-initialized boxd VM (a `Box` from `@boxd-sh/sdk`) into
 * Flue's SandboxFactory interface. The user creates and configures the VM
 * using the boxd SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * 'use agent';
 * import { Compute } from '@boxd-sh/sdk';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { boxd } from './sandboxes/boxd';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox({
 *     // Lazy, per the SandboxFactory contract: constructing this object is
 *     // cheap; the expensive boxd VM creation happens once, inside
 *     // createSessionEnv(), at initialization — never on a re-render.
 *     async createSessionEnv(options) {
 *       const client = new Compute({ apiKey: process.env.BOXD_API_KEY });
 *       const box = await client.box.create({ name: 'my-agent' });
 *       // `client` doubles as the liveness probe: the adapter polls
 *       // `client.box.get()` while a call is in flight so a dying VM
 *       // rejects the call instead of hanging it.
 *       return boxd(box, { client }).createSessionEnv(options);
 *     },
 *   });
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 */
import { createSandboxSessionEnv, SandboxDiedError } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import { NotFoundError } from '@boxd-sh/sdk';
import type { Box as BoxdBox, Compute } from '@boxd-sh/sdk';

export interface BoxdAdapterOptions {
	/**
	 * Default working directory for `exec()` calls when one isn't supplied
	 * per-call. Defaults to `/home/boxd` (the boxd VM default user's home).
	 */
	cwd?: string;
	/**
	 * How long to wait for the in-VM exec endpoint to come up before the
	 * first command, in milliseconds. boxd's `box.create()` returns once
	 * the VM is scheduled, but the agent inside it can take a moment more
	 * before exec calls succeed. Defaults to 30000 (30s); set to 0 to skip
	 * the probe entirely (useful when reusing a box you know is warm).
	 */
	readyTimeoutMs?: number;
	/**
	 * The boxd `Compute` client used to probe the VM's liveness. Strongly
	 * recommended: when provided, the adapter polls `client.box.get()`
	 * while a call is in flight and rejects with `SandboxDiedError` once
	 * the VM reports a terminal status. Without it the adapter cannot
	 * detect VM death, and a call that is in flight when the VM dies can
	 * hang forever — boxd's exec rides a gRPC stream that only settles
	 * when the server ends it, and the SDK sets no request deadline.
	 * Keep the client open while the sandbox is in use.
	 */
	client?: Compute;
}

/**
 * Poll `box.exec(['true'])` until it succeeds or the deadline passes.
 * boxd's create/fork return once the VM is scheduled; the in-VM agent
 * needs another moment before exec calls land. Resolves quietly on a
 * warm box (single successful probe) and throws on timeout.
 */
async function waitForReady(box: BoxdBox, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return;
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const probe = await box.exec(['true']);
			if (probe.exitCode === 0) return;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`[flue:boxd] VM ${box.name} did not become ready within ${timeoutMs}ms` +
			(lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
	);
}

/**
 * Quote a string for safe inclusion in a `bash -c` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How often the death detector reads VM status while a call is pending. */
const VM_STATUS_POLL_MS = 5_000;
/** How long a status probe may go unanswered before the VM is presumed dead. */
const VM_PROBE_SILENCE_MS = 10_000;

/**
 * Statuses the boxd SDK itself treats as terminal (its `waitUntilReady`
 * gives up on them): a VM in one of these states is not coming back for
 * the call that was in flight when it got there.
 */
const TERMINAL_VM_STATUSES = new Set(['destroyed', 'failed', 'stopped']);

/** Build a standard `AbortError` carrying the signal's reason message. */
function abortErrorFor(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	const message =
		reason instanceof Error && reason.message
			? reason.message
			: typeof reason === 'string' && reason
				? reason
				: 'The operation was aborted.';
	return new DOMException(message, 'AbortError');
}

/**
 * Await a boxd SDK call while watching for VM death. boxd's exec rides a
 * bidi gRPC stream that only settles when the server ends it, and the SDK
 * sets no request deadline — so a call that is in flight when the VM dies
 * can hang an agent forever. While the call is pending, this polls
 * `client.box.get()` (a cheap unary control-plane read) and rejects with
 * {@link SandboxDiedError} once the VM reports a terminal status; a probe
 * that itself goes unanswered for the silence bound means the control
 * plane is unreachable too, and the VM is presumed dead with it.
 *
 * There is deliberately no deadline on the guarded call: any status
 * outside {@link TERMINAL_VM_STATUSES} — including transitional ones like
 * `booting` and `stopping`, the suspend states `standby` and `hibernated`,
 * and unrecognized future values — counts as alive, so a legitimately slow
 * command on a healthy VM is never interrupted. When `signal` is provided,
 * its abort joins the race and rejects immediately even though the
 * underlying call cannot be cancelled remotely.
 */
function raceVmDeath<T>(
	client: Compute,
	vmId: string,
	operation: string,
	call: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		// The call is already in flight; swallow its eventual settlement so
		// the early rejection can't leave an unhandled rejection behind.
		call.catch(() => {});
		return Promise.reject(abortErrorFor(signal));
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let silenceTimer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener = (): void => {};

		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(silenceTimer);
			removeAbortListener();
			complete();
		};

		if (signal) {
			const onAbort = (): void => settle(() => reject(abortErrorFor(signal)));
			signal.addEventListener('abort', onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener('abort', onAbort);
		}

		const probe = (): void => {
			silenceTimer = setTimeout(() => {
				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
			}, VM_PROBE_SILENCE_MS);
			client.box.get(vmId).then(
				(fresh) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (TERMINAL_VM_STATUSES.has(fresh.status)) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);
					}
				},
				(err: unknown) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (err instanceof NotFoundError) {
						// NOT_FOUND for the VM id is the control plane answering
						// "no such VM" (the SDK even re-checks by name before
						// throwing it) — a destroyed VM whose record is gone,
						// not a transport blip. Authoritative death.
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
						return;
					}
					// Any other rejecting probe (connection blip, token refresh
					// hiccup, server error) is an answer, not silence — and not
					// proof of death. Keep polling.
					pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);
				},
			);
		};
		pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);

		// These handlers double as the losing branch's rejection consumer, so
		// a late settlement after death or abort can't surface as an unhandled
		// rejection.
		call.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

/**
 * Implements SandboxApi by wrapping the boxd TypeScript SDK.
 *
 * boxd's `box.exec()` takes an argv array and has no native `cwd` option,
 * so we route everything through `bash -lc` and prepend `cd <cwd>` when
 * the caller passes one. Filesystem operations that don't have a direct
 * SDK analogue (`stat`, `readdir`, `mkdir`, `rm`, `exists`) are implemented
 * via shell commands, the same pattern the Daytona adapter uses.
 *
 * When a `Compute` client is available, every SDK call goes through the
 * death detector so a call that is in flight when the VM dies settles
 * instead of hanging forever.
 */
class BoxdSandboxApi implements SandboxApi {
	constructor(
		private box: BoxdBox,
		private client?: Compute,
	) {}

	/**
	 * Await a boxd SDK call under the death detector when a `Compute`
	 * client is available; bare await otherwise (accepted limitation —
	 * see {@link BoxdAdapterOptions.client}).
	 */
	private guarded<T>(operation: string, call: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!this.client) return call;
		return raceVmDeath(this.client, this.box.id, operation, call, signal);
	}

	async readFile(path: string): Promise<string> {
		const bytes = await this.guarded('readFile', this.box.readFile(path));
		return new TextDecoder('utf-8').decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.guarded('readFile', this.box.readFile(path));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.guarded('writeFile', this.box.writeFile(path, content));
	}

	async stat(path: string): Promise<FileStat> {
		// `stat -c` is GNU stat (default on the boxd Ubuntu image). Format:
		//   <type>|<size>|<mtime-epoch>
		const result = await this.runShell(
			'stat',
			`stat -c '%F|%s|%Y' ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] stat failed for ${path}: ${result.stdout || result.stderr}`);
		}
		const fields = result.stdout.trim().split('|');
		const [type, sizeStr, mtimeStr] = fields;
		const size = Number(sizeStr);
		const mtimeSecs = Number(mtimeStr);
		const mtime = new Date(mtimeSecs * 1000);
		if (
			fields.length !== 3 ||
			!sizeStr ||
			!mtimeStr ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			!Number.isSafeInteger(mtimeSecs) ||
			!Number.isFinite(mtime.getTime())
		) {
			throw new Error(`[flue:boxd] malformed stat output for ${path}`);
		}
		return {
			isFile: type === 'regular file' || type === 'regular empty file',
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size,
			mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		// `ls -A` excludes `.` and `..` but lists dotfiles. `-1` forces one
		// entry per line so we don't have to parse columns.
		const result = await this.runShell('readdir', `ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:boxd] readdir failed for ${path}: ${result.stdout || result.stderr}`,
			);
		}
		return result.stdout.split('\n').filter((line) => line.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.runShell('exists', `test -e ${shellQuote(path)}`);
		return result.exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const cmd = options?.recursive
			? `mkdir -p ${shellQuote(path)}`
			: `mkdir ${shellQuote(path)}`;
		const result = await this.runShell('mkdir', cmd);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] mkdir failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const flagArg = flags ? `-${flags} ` : '';
		const result = await this.runShell('rm', `rm ${flagArg}${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] rm failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.runShell('exec', command, options);
	}

	private async runShell(
		operation: string,
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const wrapped = options?.cwd
			? `cd ${shellQuote(options.cwd)} && ${command}`
			: command;
		// Flue and boxd both express command timeouts in milliseconds. boxd's
		// exec does not accept an AbortSignal; the signal joins the death
		// detector's race instead, so an abort rejects immediately even
		// though the VM keeps running the command.
		const result = await this.guarded(
			operation,
			this.box.exec(['bash', '-lc', wrapped], {
				env: options?.env,
				timeoutMs: options?.timeoutMs,
			}),
			options?.signal,
		);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized boxd VM.
 * The user owns the VM lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function boxd(box: BoxdBox, options?: BoxdAdapterOptions): SandboxFactory {
	let readyPromise: Promise<void> | undefined;
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const sandboxCwd = options?.cwd ?? '/home/boxd';
			// Probe once per box, not once per session.
			readyPromise ??= waitForReady(box, options?.readyTimeoutMs ?? 30_000);
			await readyPromise;
			const api = new BoxdSandboxApi(box, options?.client);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `@boxd-sh/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @boxd-sh/sdk@^0.1.5
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This adapter needs `BOXD_API_KEY` at runtime (a long-lived API key that
starts with `bxk_`). The boxd `Compute` client also accepts a short-lived
JWT via `BOXD_TOKEN` if the user prefers. **Never invent a value for
either** — they must come from the user.

API keys are issued from the boxd dashboard at `https://boxd.sh/account`.

Use your judgment for where the secret should live. The project's
conventions, an `AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a
secret manager, CI vars, etc.) will usually tell you the right answer. If
nothing in the project gives you a clear signal, ask the user instead of
guessing.

For reference: `flue run` loads the project's `.env` by default, and
`--env <file>` selects one alternate `.env`-format file. `vite dev` and the
built server read the shell environment (`process.env`).

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
'use agent';
import { Compute } from '@boxd-sh/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { boxd } from '../sandboxes/boxd'; // adjust path to match the user's layout

export function Assistant() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox({
		// Lazy, per the SandboxFactory contract: constructing this object is
		// cheap; the expensive boxd VM creation happens once, inside
		// createSessionEnv(), at initialization — never on a re-render.
		async createSessionEnv(options) {
			const client = new Compute({ apiKey: process.env.BOXD_API_KEY });
			const box = await client.box.create({ name: `agent-${Date.now()}` });
			// Pass the client through: the adapter uses it to watch VM status
			// while calls are in flight, so a call that is in flight when the
			// VM dies fails fast with SandboxDiedError instead of hanging.
			// Keep the client open while the sandbox is in use.
			return boxd(box, { client }).createSessionEnv(options);
		},
	});
	return 'You are a helpful assistant with a full sandbox.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount `createAgentRouter(...)` (from `@flue/runtime/routing`) in
`app.ts` only if the agent needs
an HTTP endpoint — `flue run` and `dispatch()` work without a mount.

Tip: forking is significantly faster than `create()` on boxd. If the user
runs many short-lived agents off the same base image, point them at
`client.box.fork(<base>, { name: ... })` and bake their tooling into the source
VM once.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@boxd-sh/sdk` (if you didn't),
   make sure `BOXD_API_KEY` is available at runtime (per the
   Authentication section above), and run
   `flue run <path-to-the-agent-module> --message "..."` (or `vite dev`
   for the full application) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-07-22

Death detection for in-flight calls. boxd's `exec` rides a bidi gRPC stream
that only settles when the server ends it, and the SDK sets no request
deadline — so a call that was in flight when the VM was destroyed, stopped,
or failed could hang the agent forever. The adapter now accepts the boxd
`Compute` client via a new `BoxdAdapterOptions.client` option and, while any
call is pending, polls `client.box.get(<vm id>)` (a cheap unary
control-plane read, every 5s) and rejects with `SandboxDiedError` (exported
from `@flue/runtime`) once the VM reports a terminal status (`destroyed` /
`failed` / `stopped` — the states the SDK's own `waitUntilReady` treats as
terminal) or the VM record is authoritatively gone (`NotFoundError`). A
probe that itself goes unanswered for 10s presumes the control plane dead
with the VM. `exec()`'s `AbortSignal` also joins the race, so an abort
rejects immediately even though boxd cannot cancel the remote command.
Healthy-but-slow commands are never interrupted: transitional statuses
(`booting`, `stopping`), suspend states (`standby`, `hibernated`), unknown
future values, and rejecting probes all count as alive, and no polling
happens while the sandbox is idle. Without a `client` the adapter behaves
exactly as before (no liveness probing — a call in flight when the VM dies
may hang).

To upgrade, replace the adapter file with the current blueprint's version
(the new `TERMINAL_VM_STATUSES` / `abortErrorFor` / `raceVmDeath` block and
the `guarded()` plumbing are additive; your customizations to the shell
commands carry over unchanged), then pass `{ client }` where you call
`boxd(...)`. The key seams:

```diff
--- a/src/sandboxes/boxd.ts
+++ b/src/sandboxes/boxd.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: sandbox/boxd@1
+// flue-blueprint: sandbox/boxd@2
@@
-import { createSandboxSessionEnv } from '@flue/runtime';
+import { createSandboxSessionEnv, SandboxDiedError } from '@flue/runtime';
 import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
-import type { Box as BoxdBox } from '@boxd-sh/sdk';
+import { NotFoundError } from '@boxd-sh/sdk';
+import type { Box as BoxdBox, Compute } from '@boxd-sh/sdk';
@@ export interface BoxdAdapterOptions {
 	readyTimeoutMs?: number;
+	/**
+	 * The boxd `Compute` client used to probe the VM's liveness. Strongly
+	 * recommended: when provided, the adapter polls `client.box.get()`
+	 * while a call is in flight and rejects with `SandboxDiedError` once
+	 * the VM reports a terminal status. Without it the adapter cannot
+	 * detect VM death, and a call that is in flight when the VM dies can
+	 * hang forever — boxd's exec rides a gRPC stream that only settles
+	 * when the server ends it, and the SDK sets no request deadline.
+	 * Keep the client open while the sandbox is in use.
+	 */
+	client?: Compute;
 }
@@ function shellQuote(value: string): string {
 	return `'${value.replace(/'/g, `'\\''`)}'`;
 }

+// … add the VM_STATUS_POLL_MS / VM_PROBE_SILENCE_MS constants and the
+// TERMINAL_VM_STATUSES, abortErrorFor(), and raceVmDeath() definitions
+// from the current blueprint here …
+
 class BoxdSandboxApi implements SandboxApi {
-	constructor(private box: BoxdBox) {}
+	constructor(
+		private box: BoxdBox,
+		private client?: Compute,
+	) {}
+
+	private guarded<T>(operation: string, call: Promise<T>, signal?: AbortSignal): Promise<T> {
+		if (!this.client) return call;
+		return raceVmDeath(this.client, this.box.id, operation, call, signal);
+	}

 	async readFile(path: string): Promise<string> {
-		const bytes = await this.box.readFile(path);
+		const bytes = await this.guarded('readFile', this.box.readFile(path));
 		return new TextDecoder('utf-8').decode(bytes);
 	}

 	async readFileBuffer(path: string): Promise<Uint8Array> {
-		return this.box.readFile(path);
+		return this.guarded('readFile', this.box.readFile(path));
 	}

 	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
-		await this.box.writeFile(path, content);
+		await this.guarded('writeFile', this.box.writeFile(path, content));
 	}
@@
 	private async runShell(
+		operation: string,
 		command: string,
 		options?: { … },
 	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
 		const wrapped = options?.cwd
 			? `cd ${shellQuote(options.cwd)} && ${command}`
 			: command;
-		// Flue and boxd both express command timeouts in milliseconds.
-		const result = await this.box.exec(['bash', '-lc', wrapped], {
-			env: options?.env,
-			timeoutMs: options?.timeoutMs,
-		});
+		// Flue and boxd both express command timeouts in milliseconds. boxd's
+		// exec does not accept an AbortSignal; the signal joins the death
+		// detector's race instead, so an abort rejects immediately even
+		// though the VM keeps running the command.
+		const result = await this.guarded(
+			operation,
+			this.box.exec(['bash', '-lc', wrapped], {
+				env: options?.env,
+				timeoutMs: options?.timeoutMs,
+			}),
+			options?.signal,
+		);
@@ export function boxd(box: BoxdBox, options?: BoxdAdapterOptions): SandboxFactory {
-			const api = new BoxdSandboxApi(box);
+			const api = new BoxdSandboxApi(box, options?.client);
 			return createSandboxSessionEnv(api, sandboxCwd);
```

Every internal `runShell(...)` call site (`stat`, `readdir`, `exists`,
`mkdir`, `rm`, `exec`) also gains its operation name as the new first
argument.
