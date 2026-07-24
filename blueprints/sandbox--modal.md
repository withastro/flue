---
{
  "kind": "sandbox",
  "version": 2,
  "website": "https://modal.com"
}
---

# Add a Flue Sandbox Adapter: Modal

You are an AI coding agent installing the Modal sandbox adapter for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized Modal Sandbox (created with the user's own
`modal` JS SDK client) into Flue's `SandboxFactory` interface. The user owns
the Modal Sandbox lifecycle; this adapter just adapts the sandbox.

A few things worth knowing about Modal that shape this adapter:

- Modal's `sandbox.exec()` returns a long-running `ContainerProcess` with
  `stdout`/`stderr` streams, not a `{ stdout, stderr, exitCode }` result.
  The adapter pipes both streams to completion and waits for the exit
  code so it conforms to Flue's `SandboxApi.exec` shape.
- Modal's filesystem API (`sandbox.filesystem`) exposes whole-file reads
  and writes, which map directly onto Flue's `readFile`/`writeFile`. The
  adapter implements `mkdir`, `rm`, `stat`, `readdir`, and `exists` by
  shelling out (the same pattern the boxd adapter uses), which keeps
  Flue's `FileStat` semantics exact.
  This means the user's image needs `bash` and basic GNU coreutils
  available — Modal's default `python:3.13-slim` and `alpine:3.21` images
  both work fine. (Alpine ships BusyBox `stat`, which the adapter handles
  in the implementation below.)
- Modal's transports don't reliably settle a call that is in flight when
  the sandbox dies — the exec wait path retries transient errors
  indefinitely when the caller sets no deadline — which would leave an
  agent hanging forever. The adapter guards every Modal call with a death
  detector that polls `sandbox.poll()` (a cheap control-plane read that
  resolves `null` while the sandbox is running and an exit code once it
  has finished) while a call is pending, and rejects with Flue's
  `SandboxDiedError` once the sandbox reports finished.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/modal.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/modal@2
/**
 * Modal adapter for Flue.
 *
 * Wraps an already-initialized Modal Sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the Sandbox using the Modal
 * JS SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * 'use agent';
 * import { ModalClient } from 'modal';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { modal } from './sandboxes/modal';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox({
 *     // Lazy, per the SandboxFactory contract: constructing this object is
 *     // cheap; the expensive Modal sandbox creation happens once, inside
 *     // createSessionEnv(), at initialization — never on a re-render.
 *     async createSessionEnv(options) {
 *       const client = new ModalClient();
 *       const app = await client.apps.fromName('my-app', { createIfMissing: true });
 *       const image = client.images.fromRegistry('python:3.13-slim');
 *       const sandbox = await client.sandboxes.create(app, image);
 *       return modal(sandbox).createSessionEnv(options);
 *     },
 *   });
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 */
import { createSandboxSessionEnv, SandboxDiedError } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as ModalSandbox } from 'modal';

export interface ModalAdapterOptions {
	/**
	 * Default working directory for `exec()` calls when the caller doesn't
	 * pass one. Modal sandboxes don't have a strict notion of a "default
	 * cwd" — it's whatever the underlying image's WORKDIR is — so this is
	 * also the value Flue uses to resolve relative paths in the session.
	 * Defaults to "/".
	 */
	cwd?: string;
}

/**
 * Quote a string for safe inclusion in a `bash -lc` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How often the death detector polls sandbox liveness while a call is pending. */
const SANDBOX_LIVENESS_POLL_MS = 5_000;
/** How long a liveness probe may go unanswered before the sandbox is presumed dead. */
const PROBE_SILENCE_MS = 10_000;

/** The rejection value for an aborted signal (its reason, per DOM abort semantics). */
function abortErrorFor(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Await a Modal SDK call while watching for sandbox death. Modal's
 * transports can leave a call pending long after the sandbox dies — the
 * exec wait path retries transient command-router errors indefinitely when
 * the caller sets no deadline — so a bare await can hang an agent forever.
 * While the call is pending, this polls `sandbox.poll()` (a cheap
 * control-plane read that resolves `null` while the sandbox is running and
 * an exit code once it has finished) and rejects with `SandboxDiedError`
 * once the sandbox reports finished. A probe that itself goes unanswered
 * for the silence bound means the control plane is unreachable too, and
 * the sandbox is presumed dead with it — the Modal client applies no
 * default per-request timeout, so a wedged connection would otherwise
 * leave the probe pending forever; its retry middleware turns ordinary
 * transient failures into fast rejections, which the detector tolerates.
 *
 * There is deliberately no deadline: `poll()` resolving `null` — however
 * long the call has been running — counts as alive, so a legitimately slow
 * command on a healthy sandbox is never interrupted. When `signal` is
 * provided, its abort joins the race and rejects immediately even though
 * the underlying call cannot be cancelled remotely.
 */
function raceSandboxDeath<T>(
	sandbox: ModalSandbox,
	operation: string,
	call: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		// The call is already in flight; swallow its eventual settlement so the
		// early rejection can't leave an unhandled rejection behind.
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
			}, PROBE_SILENCE_MS);
			sandbox.poll().then(
				(exitCode) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (exitCode !== null) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
					}
				},
				() => {
					// A rejecting probe is an answer, not silence — and not proof
					// of death. Keep polling.
					if (settled) return;
					clearTimeout(silenceTimer);
					pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
				},
			);
		};
		pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);

		// These handlers double as the losing branch's rejection consumer, so a
		// late settlement after death or abort can't surface as an unhandled
		// rejection.
		call.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

/**
 * Implements SandboxApi by wrapping the Modal JS SDK's Sandbox class.
 *
 * Modal's surface is intentionally thin: `sandbox.exec()` for processes
 * and `sandbox.filesystem` for whole-file reads and writes. `mkdir`, `rm`,
 * `readdir`, `stat`, and `exists` are implemented via `bash -lc`
 * shell-outs (the same pattern the boxd adapter uses), which keeps Flue's
 * `FileStat` semantics exact.
 *
 * Every Modal call is awaited through the death detector (see
 * `raceSandboxDeath` above) so a call that is in flight when the sandbox
 * dies settles instead of hanging forever.
 */
class ModalSandboxApi implements SandboxApi {
	constructor(private sandbox: ModalSandbox) {}

	private guarded<T>(operation: string, call: Promise<T>, signal?: AbortSignal): Promise<T> {
		return raceSandboxDeath(this.sandbox, operation, call, signal);
	}

	async readFile(path: string): Promise<string> {
		return this.guarded('readFile', this.sandbox.filesystem.readText(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.guarded('readFile', this.sandbox.filesystem.readBytes(path));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		// Note the SDK's argument order: data first, then the remote path.
		await this.guarded(
			'writeFile',
			typeof content === 'string'
				? this.sandbox.filesystem.writeText(content, path)
				: this.sandbox.filesystem.writeBytes(content, path),
		);
	}

	async stat(path: string): Promise<FileStat> {
		// Try GNU stat first (works on Debian/Ubuntu/python:3.13-slim).
		// Fall back to BusyBox stat (Alpine). The format string differs:
		//   GNU:     %F gives "regular file" / "directory" / "symbolic link"
		//   BusyBox: %F gives the same words but is positional only with `-c`.
		// Both implementations accept `stat -c '%F|%s|%Y' <path>`.
		const result = await this.runShell(
			'stat',
			`stat -c '%F|%s|%Y' ${shellQuote(path)} 2>/dev/null`,
		);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			throw new Error(
				`[flue:modal] stat failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
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
			throw new Error(`[flue:modal] malformed stat output for ${path}`);
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
		// `ls -A1` excludes . and .. but lists dotfiles, one per line.
		const result = await this.runShell('readdir', `ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:modal] readdir failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
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
			throw new Error(
				`[flue:modal] mkdir failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const flagArg = flags ? ` -${flags}` : '';
		const result = await this.runShell('rm', `rm${flagArg} ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:modal] rm failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
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
		// Modal's exec takes argv (no shell parsing), so wrap in `bash -lc`
		// so users can pass shell commands the way Flue's other adapters
		// accept them. `pipe` for stdout/stderr is required to read them
		// back; the default `ignore` discards output.
		const proc = await this.guarded(
			operation,
			this.sandbox.exec(['bash', '-lc', command], {
				workdir: options?.cwd,
				env: options?.env,
				// Flue and Modal both express command timeouts in milliseconds.
				timeoutMs: options?.timeoutMs,
				stdout: 'pipe',
				stderr: 'pipe',
			}),
			options?.signal,
		);

		// Read both streams concurrently while the process runs, then wait
		// for the exit code. Reading first and then waiting will deadlock
		// on processes that fill their stderr buffer.
		const [stdout, stderr, exitCode] = await this.guarded(
			operation,
			Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]),
			options?.signal,
		);
		return { stdout, stderr, exitCode };
	}
}

/**
 * Create a Flue sandbox factory from an initialized Modal Sandbox.
 * The user owns the Sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function modal(sandbox: ModalSandbox, options?: ModalAdapterOptions): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const sandboxCwd = options?.cwd ?? '/';
			const api = new ModalSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `modal`, so the user's project needs to depend
on it directly. If their `package.json` does not already list it, add it:

```bash
npm install modal@^0.8.0
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

The Modal JS SDK requires Node 22 or later.

## Authentication

This adapter needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` at runtime —
both are required, neither has a default. **Never invent values for them**
— they must come from the user.

There are two paths:

- **Locally.** The user can install the Modal CLI and run `modal setup` to
  drop credentials at `~/.modal.toml`, which the SDK reads automatically.
  No env vars needed in this case.
- **In CI / serverless / containers.** The user sets `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` directly in the environment.

Tokens are issued from the Modal dashboard at
`https://modal.com/settings/tokens`.

Use your judgment for where the secrets should live in the user's project.
Their conventions, an `AGENTS.md`, or an existing setup (`.env`,
`.dev.vars`, a secret manager, CI vars, etc.) will usually tell you the
right answer. If nothing in the project gives you a clear signal, ask the
user instead of guessing.

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
import { ModalClient } from 'modal';
import { useModel, useSandbox } from '@flue/runtime';
import { modal } from '../sandboxes/modal'; // adjust path to match the user's layout

export function Assistant() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox({
		// Lazy, per the SandboxFactory contract: constructing this object is
		// cheap; the expensive Modal sandbox creation happens once, inside
		// createSessionEnv(), at initialization — never on a re-render.
		async createSessionEnv(options) {
			// ModalClient reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (or
			// ~/.modal.toml) automatically.
			const client = new ModalClient();
			const app = await client.apps.fromName('my-flue-app', { createIfMissing: true });
			const image = client.images.fromRegistry('python:3.13-slim');
			const sandbox = await client.sandboxes.create(app, image);
			return modal(sandbox).createSessionEnv(options);
		},
	});
	return 'You are a helpful assistant with a full sandbox.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount `createAgentRouter(...)` (from `@flue/runtime/routing`) in
`app.ts` only if the agent needs
an HTTP endpoint — `flue run` and `dispatch()` work without a mount.

Tip: if the user wants a faster start, prebuild a custom image with their
tooling baked in (see Modal's `image-building.ts` example) instead of
installing packages on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `modal` (if you didn't), make sure
   `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are available at runtime (per
   the Authentication section above), and run
   `flue run <path-to-the-agent-module> --message "..."` (or `vite dev`
   for the full application) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-07-22

Added sandbox death detection. Modal's transports don't reliably settle a
call that is in flight when the sandbox dies — the exec wait path retries
transient command-router errors indefinitely when the caller sets no
deadline — so an agent awaiting such a call would hang forever. Every
Modal call now goes through `raceSandboxDeath`, which polls
`sandbox.poll()` (`null` while running, an exit code once finished) while
the call is pending and rejects with Flue's `SandboxDiedError` once the
sandbox reports finished, or when a probe itself goes unanswered for the
silence bound. `exec()`'s `AbortSignal` also joins the race, so an abort
rejects immediately. Healthy slow commands are never interrupted: there is
no deadline, and a rejecting probe (a transient control-plane error) keeps
polling instead of declaring death. `runShell` gained a leading
`operation` parameter so the error names the Flue operation that died.

Also fixed the file operations: `modal@0.8.0` — the version this blueprint
installs — replaced `sandbox.open()` with `sandbox.filesystem`, so the
version-1 open/read/close code no longer type-checks against the pinned
SDK. `readFile`/`readFileBuffer`/`writeFile` now use
`sandbox.filesystem.readText`/`readBytes`/`writeText`/`writeBytes` (note
the SDK's data-first argument order on writes).

```diff
--- a/src/sandboxes/modal.ts
+++ b/src/sandboxes/modal.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: sandbox/modal@1
+// flue-blueprint: sandbox/modal@2
@@ -34,7 +34,7 @@
-import { createSandboxSessionEnv } from '@flue/runtime';
+import { createSandboxSessionEnv, SandboxDiedError } from '@flue/runtime';
 import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
 import type { Sandbox as ModalSandbox } from 'modal';
@@ -53,6 +53,109 @@ function shellQuote(value: string): string {
 	return `'${value.replace(/'/g, `'\\''`)}'`;
 }

+/** How often the death detector polls sandbox liveness while a call is pending. */
+const SANDBOX_LIVENESS_POLL_MS = 5_000;
+/** How long a liveness probe may go unanswered before the sandbox is presumed dead. */
+const PROBE_SILENCE_MS = 10_000;
+
+/** The rejection value for an aborted signal (its reason, per DOM abort semantics). */
+function abortErrorFor(signal: AbortSignal): unknown {
+	return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
+}
+
+/**
+ * Await a Modal SDK call while watching for sandbox death. Modal's
+ * transports can leave a call pending long after the sandbox dies — the
+ * exec wait path retries transient command-router errors indefinitely when
+ * the caller sets no deadline — so a bare await can hang an agent forever.
+ * While the call is pending, this polls `sandbox.poll()` (a cheap
+ * control-plane read that resolves `null` while the sandbox is running and
+ * an exit code once it has finished) and rejects with `SandboxDiedError`
+ * once the sandbox reports finished. A probe that itself goes unanswered
+ * for the silence bound means the control plane is unreachable too, and
+ * the sandbox is presumed dead with it — the Modal client applies no
+ * default per-request timeout, so a wedged connection would otherwise
+ * leave the probe pending forever; its retry middleware turns ordinary
+ * transient failures into fast rejections, which the detector tolerates.
+ *
+ * There is deliberately no deadline: `poll()` resolving `null` — however
+ * long the call has been running — counts as alive, so a legitimately slow
+ * command on a healthy sandbox is never interrupted. When `signal` is
+ * provided, its abort joins the race and rejects immediately even though
+ * the underlying call cannot be cancelled remotely.
+ */
+function raceSandboxDeath<T>(
+	sandbox: ModalSandbox,
+	operation: string,
+	call: Promise<T>,
+	signal?: AbortSignal,
+): Promise<T> {
+	if (signal?.aborted) {
+		// The call is already in flight; swallow its eventual settlement so the
+		// early rejection can't leave an unhandled rejection behind.
+		call.catch(() => {});
+		return Promise.reject(abortErrorFor(signal));
+	}
+	return new Promise<T>((resolve, reject) => {
+		let settled = false;
+		let pollTimer: ReturnType<typeof setTimeout> | undefined;
+		let silenceTimer: ReturnType<typeof setTimeout> | undefined;
+		let removeAbortListener = (): void => {};
+
+		const settle = (complete: () => void): void => {
+			if (settled) return;
+			settled = true;
+			clearTimeout(pollTimer);
+			clearTimeout(silenceTimer);
+			removeAbortListener();
+			complete();
+		};
+
+		if (signal) {
+			const onAbort = (): void => settle(() => reject(abortErrorFor(signal)));
+			signal.addEventListener('abort', onAbort, { once: true });
+			removeAbortListener = () => signal.removeEventListener('abort', onAbort);
+		}
+
+		const probe = (): void => {
+			silenceTimer = setTimeout(() => {
+				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
+			}, PROBE_SILENCE_MS);
+			sandbox.poll().then(
+				(exitCode) => {
+					if (settled) return;
+					clearTimeout(silenceTimer);
+					if (exitCode !== null) {
+						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
+					} else {
+						pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
+					}
+				},
+				() => {
+					// A rejecting probe is an answer, not silence — and not proof
+					// of death. Keep polling.
+					if (settled) return;
+					clearTimeout(silenceTimer);
+					pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
+				},
+			);
+		};
+		pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
+
+		// These handlers double as the losing branch's rejection consumer, so a
+		// late settlement after death or abort can't surface as an unhandled
+		// rejection.
+		call.then(
+			(value) => settle(() => resolve(value)),
+			(error: unknown) => settle(() => reject(error)),
+		);
+	});
+}
+
 /**
  * Implements SandboxApi by wrapping the Modal JS SDK's Sandbox class.
  *
@@ -60,37 +163,33 @@
- * Modal's surface is intentionally thin: `sandbox.exec()` for processes
- * and `sandbox.open()` for individual files. There's no built-in `mkdir`,
- * `rm`, `readdir`, `stat`, or `exists`, so those are implemented via
- * `bash -lc` shell-outs. This is the same pattern the boxd adapter uses.
+ * Modal's surface is intentionally thin: `sandbox.exec()` for processes
+ * and `sandbox.filesystem` for whole-file reads and writes. `mkdir`, `rm`,
+ * `readdir`, `stat`, and `exists` are implemented via `bash -lc`
+ * shell-outs (the same pattern the boxd adapter uses), which keeps Flue's
+ * `FileStat` semantics exact.
+ *
+ * Every Modal call is awaited through the death detector (see
+ * `raceSandboxDeath` above) so a call that is in flight when the sandbox
+ * dies settles instead of hanging forever.
  */
 class ModalSandboxApi implements SandboxApi {
 	constructor(private sandbox: ModalSandbox) {}

+	private guarded<T>(operation: string, call: Promise<T>, signal?: AbortSignal): Promise<T> {
+		return raceSandboxDeath(this.sandbox, operation, call, signal);
+	}
+
 	async readFile(path: string): Promise<string> {
-		const handle = await this.sandbox.open(path, 'r');
-		try {
-			const bytes = await handle.read();
-			return new TextDecoder('utf-8').decode(bytes);
-		} finally {
-			await handle.close();
-		}
+		return this.guarded('readFile', this.sandbox.filesystem.readText(path));
 	}

 	async readFileBuffer(path: string): Promise<Uint8Array> {
-		const handle = await this.sandbox.open(path, 'r');
-		try {
-			return await handle.read();
-		} finally {
-			await handle.close();
-		}
+		return this.guarded('readFile', this.sandbox.filesystem.readBytes(path));
 	}

 	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
-		const handle = await this.sandbox.open(path, 'w');
-		try {
-			const data =
-				typeof content === 'string' ? new TextEncoder().encode(content) : content;
-			await handle.write(data);
-			await handle.flush();
-		} finally {
-			await handle.close();
-		}
+		// Note the SDK's argument order: data first, then the remote path.
+		await this.guarded(
+			'writeFile',
+			typeof content === 'string'
+				? this.sandbox.filesystem.writeText(content, path)
+				: this.sandbox.filesystem.writeBytes(content, path),
+		);
 	}
@@ -104,6 +215,7 @@
 		const result = await this.runShell(
+			'stat',
 			`stat -c '%F|%s|%Y' ${shellQuote(path)} 2>/dev/null`,
 		);
@@ -139,7 +251,7 @@
-		const result = await this.runShell(`ls -A1 ${shellQuote(path)}`);
+		const result = await this.runShell('readdir', `ls -A1 ${shellQuote(path)}`);
@@ -150,7 +262,7 @@
-		const result = await this.runShell(`test -e ${shellQuote(path)}`);
+		const result = await this.runShell('exists', `test -e ${shellQuote(path)}`);
@@ -158,7 +270,7 @@
 			: `mkdir ${shellQuote(path)}`;
-		const result = await this.runShell(cmd);
+		const result = await this.runShell('mkdir', cmd);
@@ -170,7 +282,7 @@
-		const result = await this.runShell(`rm${flagArg} ${shellQuote(path)}`);
+		const result = await this.runShell('rm', `rm${flagArg} ${shellQuote(path)}`);
@@ -182,37 +294,47 @@
 	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
-		return this.runShell(command, options);
+		return this.runShell('exec', command, options);
 	}

 	private async runShell(
+		operation: string,
 		command: string,
 		options?: {
 			cwd?: string;
 			env?: Record<string, string>;
 			timeoutMs?: number;
 			signal?: AbortSignal;
 		},
 	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
 		// Modal's exec takes argv (no shell parsing), so wrap in `bash -lc`
 		// so users can pass shell commands the way Flue's other adapters
 		// accept them. `pipe` for stdout/stderr is required to read them
 		// back; the default `ignore` discards output.
-		const proc = await this.sandbox.exec(['bash', '-lc', command], {
-			workdir: options?.cwd,
-			env: options?.env,
-			// Flue and Modal both express command timeouts in milliseconds.
-			timeoutMs: options?.timeoutMs,
-			stdout: 'pipe',
-			stderr: 'pipe',
-		});
+		const proc = await this.guarded(
+			operation,
+			this.sandbox.exec(['bash', '-lc', command], {
+				workdir: options?.cwd,
+				env: options?.env,
+				// Flue and Modal both express command timeouts in milliseconds.
+				timeoutMs: options?.timeoutMs,
+				stdout: 'pipe',
+				stderr: 'pipe',
+			}),
+			options?.signal,
+		);

 		// Read both streams concurrently while the process runs, then wait
 		// for the exit code. Reading first and then waiting will deadlock
 		// on processes that fill their stderr buffer.
-		const [stdout, stderr, exitCode] = await Promise.all([
-			proc.stdout.readText(),
-			proc.stderr.readText(),
-			proc.wait(),
-		]);
+		const [stdout, stderr, exitCode] = await this.guarded(
+			operation,
+			Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]),
+			options?.signal,
+		);
 		return { stdout, stderr, exitCode };
 	}
```
