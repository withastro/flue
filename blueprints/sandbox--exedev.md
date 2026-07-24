---
{
  "kind": "sandbox",
  "version": 2,
  "website": "https://exe.dev",
  "aliases": ["exe"]
}
---

# Add a Flue Sandbox Adapter: exe.dev

You are an AI coding agent installing the exe.dev sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout or a
missing required VM hostname).

## What this adapter does

Wraps an already-available exe.dev VM into Flue's `SandboxFactory` interface
over SSH + SFTP. The user owns the VM lifecycle; this adapter just adapts
the VM.

This adapter depends on Node.js APIs and the `ssh2` package, so use it with
Flue's Node target. It is not suitable for Cloudflare Worker-target agents.

exe.dev also exposes an HTTPS API (`POST https://exe.dev/exec`) for VM
lifecycle commands like `new`, `cp`, and `rm`. This guide includes optional
helpers for that setup work, but `exedev(...)` itself only wraps a VM that
already exists.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/exedev.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/exedev@2
/**
 * exe.dev adapter for Flue.
 *
 * Wraps an already-available exe.dev VM into Flue's SandboxFactory interface
 * using SSH for shell commands and SFTP for file operations.
 *
 * This adapter depends on Node.js APIs and the `ssh2` package, so use it
 * with Flue's Node target. It is not suitable for Cloudflare Worker-target
 * agents.
 *
 * Optional lifecycle helpers (`createExeVm`, `cloneExeVm`, `deleteExeVm`)
 * use exe.dev's HTTPS API before/after agent setup. The adapter itself
 * does not create, clone, or delete infrastructure.
 *
 * The SSH connection doubles as the liveness channel: SSH-level keepalives
 * surface a silently dead VM as a connection close, and every in-flight
 * operation settles with SandboxDiedError instead of hanging. See the
 * death watcher in ExeDevSandboxApi.
 *
 * @example Existing VM (most common)
 * ```typescript
 * 'use agent';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { exedev } from './sandboxes/exedev';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox(exedev({ host: 'maple-dune.exe.xyz' }));
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 *
 * @example Create a VM before wrapping it
 * ```typescript
 * 'use agent';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { createExeVm, exedev } from './sandboxes/exedev';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox({
 *     // Lazy, per the SandboxFactory contract: constructing this object is
 *     // cheap; the expensive VM creation happens once, inside
 *     // createSessionEnv(), at initialization — never on a re-render.
 *     async createSessionEnv(options) {
 *       const vm = await createExeVm({ apiToken: process.env.EXE_API_TOKEN });
 *       return exedev(vm).createSessionEnv(options);
 *     },
 *   });
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 */
import {
  createSandboxSessionEnv,
  SandboxDiedError,
  SandboxOperationUnsupportedError,
} from "@flue/runtime";
import type {
  FileStat,
  SandboxApi,
  SandboxFactory,
  SessionEnv,
} from "@flue/runtime";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

export interface ExeDevVm {
  /** VM hostname, e.g. "maple-dune.exe.xyz". */
  host: string;
  /** VM name, used by lifecycle helpers for deletion. */
  name?: string;
  /** SSH port. Defaults to 22. */
  port?: number;
}

export interface ExeDevAdapterOptions {
  /** SSH username on the VM. Defaults to "user" (exeuntu default). */
  username?: string;
  /** SSH port. Defaults to the VM port, then 22. */
  port?: number;
  /** SSH private key as a raw PEM string or Buffer. */
  privateKey?: string | Buffer;
  /** Path to an SSH private key file. */
  privateKeyPath?: string;
  /** SSH agent socket path. Falls back to `$SSH_AUTH_SOCK` when no key resolves. */
  agent?: string;
}

export interface ExeDevLifecycleOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** Optional VM name for `new <name>`. Omit to let exe.dev generate one. */
  name?: string;
  /** How long to wait for SSH after create/clone. Defaults to 90000ms. */
  readyTimeoutMs?: number;
  /** SSH options used for the readiness check. */
  ssh?: ExeDevAdapterOptions;
}

export interface CloneExeVmOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** Source VM name to clone with `cp <source>`. */
  source: string;
  /** How long to wait for SSH after clone. Defaults to 90000ms. */
  readyTimeoutMs?: number;
  /** SSH options used for the readiness check. */
  ssh?: ExeDevAdapterOptions;
}

export interface DeleteExeVmOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** VM name to delete with `rm <name>`. */
  name: string;
}

export class ExeDevError extends Error {
  override name = "ExeDevError";

  constructor(message: string) {
    super(message);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, ExeDevError);
    }
  }
}

const EXE_API_URL = "https://exe.dev/exec";
const DEFAULT_VM_READY_TIMEOUT_MS = 90_000;
/** How often ssh2 sends an SSH-level keepalive while the connection is open. */
const SSH_KEEPALIVE_INTERVAL_MS = 5_000;
/** Consecutive unanswered keepalives before ssh2 declares the connection dead. */
const SSH_KEEPALIVE_COUNT_MAX = 2;
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHELL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Run an exe.dev CLI command via the HTTPS API. */
async function exeApi(token: string, command: string): Promise<string> {
  const res = await fetch(EXE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: command,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new ExeDevError(
      `exe.dev HTTPS API returned ${res.status}.\n` +
        `  Response: ${body.slice(0, 200)}\n` +
        `  Check that your apiToken is valid and that its 'cmds' include the command you're running.`,
    );
  }
  return body;
}

/** Parse the JSON body from a `new` / `cp` HTTPS API call. */
export function parseVmResponse(output: string): ExeDevVm & { name: string } {
  let data: {
    vm_name?: unknown;
    name?: unknown;
    vm?: unknown;
    ssh_dest?: unknown;
    ssh_port?: unknown;
  };
  try {
    data = JSON.parse(output);
  } catch {
    throw new ExeDevError(
      "exe.dev HTTPS API returned non-JSON output:\n" + `  ${output.slice(0, 200)}`,
    );
  }
  const name =
    typeof data.vm_name === "string"
      ? data.vm_name
      : typeof data.name === "string"
        ? data.name
        : typeof data.vm === "string"
          ? data.vm
          : undefined;
  if (!name) {
    throw new ExeDevError(
      "exe.dev HTTPS API response missing `vm_name`:\n" +
        `  ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  const host =
    typeof data.ssh_dest === "string" && data.ssh_dest
      ? data.ssh_dest
      : `${name}.exe.xyz`;
  const port =
    typeof data.ssh_port === "number" && Number.isFinite(data.ssh_port)
      ? data.ssh_port
      : undefined;
  return { name, host, port };
}

/** Create a VM via exe.dev's HTTPS API, then wait for SSH readiness. */
export async function createExeVm(options: ExeDevLifecycleOptions): Promise<ExeDevVm & { name: string }> {
  const cmd = options.name ? `new ${validateVmName(options.name)}` : "new";
  const vm = parseVmResponse(await exeApi(options.apiToken, cmd));
  await waitForExeVm(vm, options.ssh, options.readyTimeoutMs);
  return vm;
}

/** Clone a VM via exe.dev's HTTPS API, then wait for SSH readiness. */
export async function cloneExeVm(options: CloneExeVmOptions): Promise<ExeDevVm & { name: string }> {
  const vm = parseVmResponse(await exeApi(options.apiToken, `cp ${validateVmName(options.source)}`));
  await waitForExeVm(vm, options.ssh, options.readyTimeoutMs);
  return vm;
}

/** Delete a VM via exe.dev's HTTPS API. */
export async function deleteExeVm(options: DeleteExeVmOptions): Promise<void> {
  await exeApi(options.apiToken, `rm ${validateVmName(options.name)}`);
}

/** Wait until an exe.dev VM accepts SSH connections. */
export async function waitForExeVm(
  vm: ExeDevVm,
  options?: ExeDevAdapterOptions,
  timeoutMs = DEFAULT_VM_READY_TIMEOUT_MS,
): Promise<void> {
  if (timeoutMs <= 0) return;
  const { disconnect } = await sshConnectWithRetry(vm, options ?? {}, timeoutMs);
  disconnect();
}

function validateVmName(name: string): string {
  if (!VM_NAME.test(name)) {
    throw new ExeDevError(`Invalid exe.dev VM name: ${name}`);
  }
  return name;
}

/** Escape a string for safe use inside single-quoted shell args. */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Build a shell-safe environment assignment for SSH exec. */
function shellEnvAssignment(name: string, value: string): string {
  if (!SHELL_ENV_NAME.test(name)) {
    throw new ExeDevError(`Invalid environment variable name: ${name}`);
  }
  return `${name}='${shellEscape(value)}'`;
}

/** Build a standard `AbortError` (`DOMException`) from an aborted signal. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const message =
    reason instanceof Error && reason.message
      ? reason.message
      : typeof reason === "string" && reason
        ? reason
        : "The operation was aborted.";
  return new DOMException(message, "AbortError");
}

/** Resolve SSH auth — either a private key (file/buffer) or an agent socket. */
export function resolveAuth(
  opts: ExeDevAdapterOptions,
  env: NodeJS.ProcessEnv = process.env,
): { privateKey?: string | Buffer; agent?: string } {
  if (opts.privateKey) return { privateKey: opts.privateKey };
  if (opts.agent) return { agent: opts.agent };

  const tried: { source: string; path: string; reason: string }[] = [];

  const tryPath = (keyPath: string, source: string): string | Buffer | undefined => {
    try {
      return fs.readFileSync(keyPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "ERROR";
      tried.push({ source, path: keyPath, reason: code });
      return undefined;
    }
  };

  if (opts.privateKeyPath) {
    const key = tryPath(opts.privateKeyPath, "privateKeyPath option");
    if (key) return { privateKey: key };
  }

  const envPath = env.EXE_SSH_KEY;
  if (envPath) {
    const key = tryPath(envPath, "$EXE_SSH_KEY");
    if (key) return { privateKey: key };
  }

  const home = os.homedir();
  for (const name of ["id_ed25519", "id_rsa"]) {
    const keyPath = path.join(home, ".ssh", name);
    const key = tryPath(keyPath, "default");
    if (key) return { privateKey: key };
  }

  if (env.SSH_AUTH_SOCK) return { agent: env.SSH_AUTH_SOCK };

  const triedLines =
    tried.length > 0
      ? tried.map((t) => `    - ${t.path} (${t.source}, ${t.reason})`).join("\n")
      : "    (none)";

  throw new ExeDevError(
    "Couldn't find an SSH private key or running agent.\n" +
      `  Tried:\n${triedLines}\n` +
      "  Fix it by one of:\n" +
      "    - Pass `agent: '/path/to/agent.sock'` (or set $SSH_AUTH_SOCK)\n" +
      "    - Set EXE_SSH_KEY=/path/to/your/key\n" +
      "    - Pass `privateKeyPath` or `privateKey` to exedev()\n" +
      "    - Generate a default key: ssh-keygen -t ed25519",
  );
}

const RETRYABLE_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export function isRetryableSshError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof e.code === "string" && RETRYABLE_ERROR_CODES.has(e.code)) return true;
  if (typeof e.errno === "string" && RETRYABLE_ERROR_CODES.has(e.errno)) return true;
  return (
    typeof e.message === "string" &&
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(
      e.message,
    )
  );
}

async function sshConnectWithRetry(
  vm: ExeDevVm,
  opts: ExeDevAdapterOptions,
  timeoutMs: number,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const start = Date.now();
  let lastErr: unknown;
  while (true) {
    try {
      return await sshConnect(vm, opts);
    } catch (err) {
      lastErr = err;
      if (!isRetryableSshError(err)) throw err;
      if (Date.now() - start > timeoutMs) {
        throw new ExeDevError(
          `Timed out after ${Math.round((Date.now() - start) / 1000)}s waiting ` +
            `for ${vm.host} to become SSH-able.\n` +
            `  Last error: ${(lastErr as Error)?.message ?? String(lastErr)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function sshConnect(
  vm: ExeDevVm,
  opts: ExeDevAdapterOptions,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const ssh = new SSHClient();
  const config: ConnectConfig = {
    host: vm.host,
    port: opts.port ?? vm.port ?? 22,
    username: opts.username ?? "user",
    // A VM that dies with a TCP reset fails in-flight calls natively, but a
    // VM that vanishes silently (deleted mid-command, host gone) leaves the
    // socket established and every pending call hanging. SSH-level
    // keepalives turn that silence into a socket teardown after
    // SSH_KEEPALIVE_COUNT_MAX unanswered probes, which settles every
    // in-flight operation (see the death watcher in ExeDevSandboxApi).
    // sshd answers keepalives regardless of how long a command runs, so a
    // legitimately slow command on a healthy VM never trips them.
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    ...resolveAuth(opts),
  };

  await new Promise<void>((resolve, reject) => {
    ssh.on("ready", resolve);
    ssh.on("error", reject);
    ssh.connect(config);
  });

  return {
    ssh,
    disconnect: () => ssh.end(),
  };
}

export interface SshLike {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
  exec(
    command: string,
    options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

export interface SshExecStream {
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  stderr: { on(event: "data", listener: (data: Buffer) => void): unknown };
  close(): void;
}

export class ExeDevSandboxApi implements SandboxApi {
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  /** Set once the SSH connection is gone; guarded calls reject after that. */
  private deathReason: "stopped" | "probe_silent" | null = null;
  private deathWaiters = new Set<() => void>();

  constructor(private ssh: SshLike) {
    // ssh2 tears the socket down when SSH_KEEPALIVE_COUNT_MAX consecutive
    // keepalives go unanswered, emitting 'error' ("Keepalive timeout",
    // level 'client-timeout') and then 'close'. 'close' also follows a TCP
    // reset or an orderly disconnect, so it is the single authoritative
    // death signal. sshConnect() keeps an 'error' listener attached, so the
    // preceding 'error' event cannot crash the process.
    let sawKeepaliveTimeout = false;
    this.ssh.on("error", (err) => {
      if ((err as Error & { level?: string }).level === "client-timeout") {
        sawKeepaliveTimeout = true;
      }
    });
    this.ssh.once("close", () => {
      this.deathReason = sawKeepaliveTimeout ? "probe_silent" : "stopped";
      const waiters = [...this.deathWaiters];
      this.deathWaiters.clear();
      for (const waiter of waiters) waiter();
    });
  }

  private diedError(operation: string): SandboxDiedError {
    return new SandboxDiedError({
      operation,
      reason: this.deathReason ?? "stopped",
    });
  }

  /**
   * Await an SSH operation while watching for connection death. SSH is the
   * liveness channel itself: a VM that dies with a TCP reset fails every
   * in-flight ssh2 callback natively, and a VM that dies silently is caught
   * by the keepalives configured in sshConnect(), which destroy the socket.
   * Either way the client emits 'close' and this race rejects with
   * SandboxDiedError, so a call that is in flight when the VM dies settles
   * (and is classified as an infrastructure failure) instead of hanging —
   * or, for exec, resolving as a phantom success when the channel closes
   * without an exit code.
   *
   * There is deliberately no per-command deadline here; a healthy slow
   * command is never interrupted. When `signal` is provided, its abort
   * joins the race and rejects immediately even though the remote command
   * cannot be cancelled mid-flight.
   *
   * Channel opens (getSftp) are not raced: ssh2 fails a pending channel
   * open natively when the connection closes.
   */
  private guarded<T>(operation: string, op: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      // The call is already in flight; swallow its eventual settlement so
      // the early rejection can't leave an unhandled rejection behind.
      op.catch(() => {});
      return Promise.reject(abortError(signal));
    }
    if (this.deathReason) {
      op.catch(() => {});
      return Promise.reject(this.diedError(operation));
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let removeAbortListener = (): void => {};

      const settle = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        this.deathWaiters.delete(onDeath);
        removeAbortListener();
        complete();
      };
      const onDeath = (): void => settle(() => reject(this.diedError(operation)));
      this.deathWaiters.add(onDeath);

      if (signal) {
        const onAbort = (): void => settle(() => reject(abortError(signal)));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }

      // These handlers double as the losing branch's rejection consumer, so
      // a late settlement after death or abort can't surface as an
      // unhandled rejection.
      op.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftpInstance) return Promise.resolve(this.sftpInstance);
    if (this.sftpPromise) return this.sftpPromise;
    this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this.ssh.sftp((err, s) => {
        if (err) {
          this.sftpPromise = null;
          return reject(err);
        }
        const drop = () => {
          if (this.sftpInstance === s) this.sftpInstance = null;
          if (this.sftpPromise) this.sftpPromise = null;
        };
        s.once("close", drop);
        s.once("end", drop);
        s.on("error", drop);
        this.sftpInstance = s;
        resolve(s);
      });
    });
    return this.sftpPromise;
  }

  async readFile(filePath: string): Promise<string> {
    const sftp = await this.getSftp();
    const op = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath, { encoding: "utf-8" });
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });
    return this.guarded("readFile", op);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const sftp = await this.getSftp();
    const op = new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath);
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", reject);
    });
    return this.guarded("readFile", op);
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const sftp = await this.getSftp();
    const op = new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on("close", () => resolve());
      stream.on("error", reject);
      stream.end(buf);
    });
    return this.guarded("writeFile", op);
  }

  async stat(filePath: string): Promise<FileStat> {
    const sftp = await this.getSftp();
    const op = new Promise<FileStat>((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          isSymbolicLink: stats.isSymbolicLink(),
          size: stats.size,
          mtime: new Date(stats.mtime * 1000),
        });
      });
    });
    return this.guarded("stat", op);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const sftp = await this.getSftp();
    const op = new Promise<string[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((entry) => entry.filename));
      });
    });
    return this.guarded("readdir", op);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch (err) {
      // Sandbox death must reject, not read as "file absent".
      if (err instanceof SandboxDiedError) throw err;
      return false;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      await this.exec(`mkdir -p '${shellEscape(dirPath)}'`);
      return;
    }
    const sftp = await this.getSftp();
    const op = new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
    return this.guarded("mkdir", op);
  }

  async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const unsupported = [
      options?.recursive ? "recursive" : undefined,
      options?.force ? "force" : undefined,
    ].filter((option): option is string => option !== undefined);
    if (unsupported.length > 0) {
      throw new SandboxOperationUnsupportedError({
        operation: "rm",
        provider: "exe.dev",
        options: unsupported,
      });
    }
    const sftp = await this.getSftp();
    const op = new Promise<void>((resolve, reject) => {
      sftp.unlink(filePath, (unlinkErr) => {
        if (!unlinkErr) return resolve();
        sftp.rmdir(filePath, (rmdirErr) => (rmdirErr ? reject(rmdirErr) : resolve()));
      });
    });
    return this.guarded("rm", op);
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
    let cmd = command;

    if (options?.env && Object.keys(options.env).length > 0) {
      const envPrefix = Object.entries(options.env)
        .map(([k, v]) => `export ${shellEnvAssignment(k, v)}`)
        .join("; ");
      cmd = `${envPrefix}; ${cmd}`;
    }
    if (options?.cwd) {
      cmd = `cd '${shellEscape(options.cwd)}' && ${cmd}`;
    }

    // ssh2 cannot cancel a remote command mid-flight. The signal instead
    // joins the death watcher's race (see guarded()), so an abort rejects
    // immediately even though the VM keeps running the command; Flue's
    // runtime additionally enforces pre/post signal checks.
    const op = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      this.ssh.exec(cmd, {}, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: { stdout: string; stderr: string; exitCode: number }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };

        if (typeof options?.timeoutMs === "number") {
          timer = setTimeout(() => {
            stream.close();
            finish({
              stdout,
              stderr: `${stderr}\n[flue:exedev] Command timed out after ${options.timeoutMs} milliseconds.`,
              exitCode: 124,
            });
          }, options.timeoutMs);
        }

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", (code: number) => {
          finish({ stdout, stderr, exitCode: code ?? 0 });
        });
        stream.on("error", (streamErr: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
    return this.guarded("exec", op, options?.signal);
  }
}

export function exedev(vm: ExeDevVm | string, options?: ExeDevAdapterOptions): SandboxFactory {
  const resolvedVm = typeof vm === "string" ? { host: vm } : vm;
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const { ssh } = await sshConnect(resolvedVm, options ?? {});
      const api = new ExeDevSandboxApi(ssh);

      let sandboxCwd = "/home/user";
      try {
        const { stdout } = await api.exec("echo $HOME");
        const detected = stdout.trim();
        if (detected) sandboxCwd = detected;
      } catch {
        // Fall back to /home/user.
      }

      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

## Required dependencies

This adapter imports from Node.js built-ins and `ssh2`, so it requires
Flue's Node target and the user's project needs to depend on `ssh2` directly.
If their `package.json` does not already list it, add it:

```bash
npm install ssh2@^1.17.0
npm install -D @types/ssh2@^1.15.5
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

SSH is always required. The adapter auto-detects SSH auth in this order:

1. `privateKey` option (raw PEM)
2. `agent` option (socket path)
3. `privateKeyPath` option (file path)
4. `$EXE_SSH_KEY` env var (file path)
5. `~/.ssh/id_ed25519`
6. `~/.ssh/id_rsa`
7. `$SSH_AUTH_SOCK` env var (last-resort agent fallback)

These should be the same keys the user registered when first running
`ssh exe.dev`.

An exe.dev HTTPS API token is only needed if the user asks you to create,
clone, or delete VMs with `createExeVm`, `cloneExeVm`, or `deleteExeVm`.
Do not generate or register API keys unless the user explicitly asks you to.
If you need a token value, never invent one — it must come from the user or
from the project's existing secret setup.

To generate a token manually, exe.dev signs compact JSON permissions with an
SSH key. For lifecycle helpers, the token's `cmds` must include the commands
the helper uses: `new`, `cp`, and/or `rm`. The default exe.dev token commands
include `new` but not `cp` or `rm`, so cloning and deletion require explicit
permissions.

For reference, token generation looks like this:

```bash
ssh-keygen -t ed25519 -C api -f ~/.ssh/exe_dev_api
cat ~/.ssh/exe_dev_api.pub | ssh exe.dev ssh-key add

b64url() { tr -d '\n=' | tr '+/' '-_'; }
PERMISSIONS='{"cmds":["new","cp","rm","whoami"]}'
PAYLOAD=$(printf '%s' "$PERMISSIONS" | base64 | b64url)
SIG=$(printf '%s' "$PERMISSIONS" | ssh-keygen -Y sign -f ~/.ssh/exe_dev_api -n v0@exe.dev)
SIGBLOB=$(echo "$SIG" | sed '1d;$d' | b64url)
TOKEN="exe0.$PAYLOAD.$SIGBLOB"

curl -X POST https://exe.dev/exec -H "Authorization: Bearer $TOKEN" -d 'whoami'
```

Use project conventions (`.env`, `.dev.vars`, a secret manager, CI vars,
etc.) for storing any token or host values. If nothing in the project gives
you a clear signal, ask the user instead of guessing.

For reference: `flue run` loads the project's `.env` by default, and
`--env <file>` selects one alternate `.env`-format file. `vite dev` and the
built server read the shell environment (`process.env`).

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share the relevant snippet so they can wire it up themselves.

### Existing VM

Use this by default. If the user did not provide a VM hostname and there is
no obvious project convention like `EXE_VM_HOST`, ask for the exe.dev VM
hostname before wiring the adapter.

```ts
'use agent';
import { useModel, useSandbox } from "@flue/runtime";
import { exedev } from "../sandboxes/exedev";

export function Assistant() {
	useModel("anthropic/claude-sonnet-4-6");
	useSandbox(exedev({ host: process.env.EXE_VM_HOST }));
	return "You are a helpful assistant with a full sandbox.";
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount `createAgentRouter(...)` (from `@flue/runtime/routing`) in
`app.ts` only if the agent needs
an HTTP endpoint — `flue run` and `dispatch()` work without a mount.

### Fresh VM

Only use this when the user explicitly asks to create a VM and provides an
API token with `new` permission. The `createSessionEnv` closure creates the
VM and passes it to `exedev(...)`.

```ts
'use agent';
import { useModel, useSandbox } from "@flue/runtime";
import { createExeVm, exedev } from "../sandboxes/exedev";

export function Assistant() {
	useModel("anthropic/claude-sonnet-4-6");
	useSandbox({
		async createSessionEnv(options) {
			const vm = await createExeVm({ apiToken: process.env.EXE_API_TOKEN });
			return exedev(vm).createSessionEnv(options);
		},
	});
	return "You are a helpful assistant with a full sandbox.";
}
```

### Cloned VM

Only use this when the user explicitly asks to clone a base VM and provides
an API token with `cp` permission. If the project also deletes the clone, the
token needs `rm` permission.

```ts
'use agent';
import { useModel, useSandbox } from "@flue/runtime";
import { cloneExeVm, exedev } from "../sandboxes/exedev";

export function Assistant() {
	useModel("anthropic/claude-sonnet-4-6");
	useSandbox({
		async createSessionEnv(options) {
			const vm = await cloneExeVm({
				apiToken: process.env.EXE_API_TOKEN,
				source: "my-dev-vm",
			});
			return exedev(vm).createSessionEnv(options);
		},
	});
	return "You are a helpful assistant with a full sandbox.";
}
```

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm `ssh user@<vm-host> echo hello` works for existing-VM mode.
3. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
4. Tell the user the next steps: install `ssh2` and `@types/ssh2` (if you
   didn't), make sure the needed exe.dev SSH/API values are available at
   runtime (per the Authentication section above), and run
   `flue run <path-to-the-agent-module> --message "..."` (or `vite dev`
   for the full application) to try it. Both require the Node target —
   this adapter is not Cloudflare-compatible.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-07-22

Death detection over the SSH connection. A VM that died with a TCP reset
already failed in-flight calls natively, but a VM that vanished silently
(deleted mid-command, host gone) left the socket established forever: SFTP
calls hung, and `exec` could even resolve as a phantom success with exit
code 0 when the channel finally closed without an exit status. The adapter
now enables ssh2's documented SSH-level keepalives (`keepaliveInterval` /
`keepaliveCountMax`), so a silent death tears the socket down within
roughly 10–15 seconds, and races every operation against connection death
so interrupted calls reject with `SandboxDiedError` (imported from
`@flue/runtime`). Healthy slow commands are unaffected — sshd answers
keepalives regardless of how long a command runs, and there is still no
per-command deadline. `exec` also honors an in-flight `AbortSignal` by
rejecting immediately, and `exists` re-throws `SandboxDiedError` instead
of reading death as "file absent".

```diff
--- a/src/sandboxes/exedev.ts
+++ b/src/sandboxes/exedev.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: sandbox/exedev@1
+// flue-blueprint: sandbox/exedev@2
 /**
  * exe.dev adapter for Flue.
  *
@@ -13,6 +13,11 @@
  * use exe.dev's HTTPS API before/after agent setup. The adapter itself
  * does not create, clone, or delete infrastructure.
  *
+ * The SSH connection doubles as the liveness channel: SSH-level keepalives
+ * surface a silently dead VM as a connection close, and every in-flight
+ * operation settles with SandboxDiedError instead of hanging. See the
+ * death watcher in ExeDevSandboxApi.
+ *
  * @example Existing VM (most common)
  * ```typescript
  * 'use agent';
@@ -49,6 +54,7 @@
  */
 import {
   createSandboxSessionEnv,
+  SandboxDiedError,
   SandboxOperationUnsupportedError,
 } from "@flue/runtime";
 import type {
@@ -127,6 +133,10 @@
 
 const EXE_API_URL = "https://exe.dev/exec";
 const DEFAULT_VM_READY_TIMEOUT_MS = 90_000;
+/** How often ssh2 sends an SSH-level keepalive while the connection is open. */
+const SSH_KEEPALIVE_INTERVAL_MS = 5_000;
+/** Consecutive unanswered keepalives before ssh2 declares the connection dead. */
+const SSH_KEEPALIVE_COUNT_MAX = 2;
 const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
 const SHELL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
 
@@ -241,6 +251,18 @@
     throw new ExeDevError(`Invalid environment variable name: ${name}`);
   }
   return `${name}='${shellEscape(value)}'`;
+}
+
+/** Build a standard `AbortError` (`DOMException`) from an aborted signal. */
+function abortError(signal: AbortSignal): Error {
+  const reason: unknown = signal.reason;
+  const message =
+    reason instanceof Error && reason.message
+      ? reason.message
+      : typeof reason === "string" && reason
+        ? reason
+        : "The operation was aborted.";
+  return new DOMException(message, "AbortError");
 }
 
 /** Resolve SSH auth — either a private key (file/buffer) or an agent socket. */
@@ -356,6 +378,16 @@
     host: vm.host,
     port: opts.port ?? vm.port ?? 22,
     username: opts.username ?? "user",
+    // A VM that dies with a TCP reset fails in-flight calls natively, but a
+    // VM that vanishes silently (deleted mid-command, host gone) leaves the
+    // socket established and every pending call hanging. SSH-level
+    // keepalives turn that silence into a socket teardown after
+    // SSH_KEEPALIVE_COUNT_MAX unanswered probes, which settles every
+    // in-flight operation (see the death watcher in ExeDevSandboxApi).
+    // sshd answers keepalives regardless of how long a command runs, so a
+    // legitimately slow command on a healthy VM never trips them.
+    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
+    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
     ...resolveAuth(opts),
   };
 
@@ -378,6 +410,8 @@
     options: object,
     cb: (err: Error | undefined, stream: SshExecStream) => void,
   ): unknown;
+  on(event: "error", listener: (err: Error) => void): unknown;
+  once(event: "close", listener: () => void): unknown;
 }
 
 export interface SshExecStream {
@@ -391,9 +425,98 @@
 export class ExeDevSandboxApi implements SandboxApi {
   private sftpInstance: SFTPWrapper | null = null;
   private sftpPromise: Promise<SFTPWrapper> | null = null;
+  /** Set once the SSH connection is gone; guarded calls reject after that. */
+  private deathReason: "stopped" | "probe_silent" | null = null;
+  private deathWaiters = new Set<() => void>();
 
-  constructor(private ssh: SshLike) {}
+  constructor(private ssh: SshLike) {
+    // ssh2 tears the socket down when SSH_KEEPALIVE_COUNT_MAX consecutive
+    // keepalives go unanswered, emitting 'error' ("Keepalive timeout",
+    // level 'client-timeout') and then 'close'. 'close' also follows a TCP
+    // reset or an orderly disconnect, so it is the single authoritative
+    // death signal. sshConnect() keeps an 'error' listener attached, so the
+    // preceding 'error' event cannot crash the process.
+    let sawKeepaliveTimeout = false;
+    this.ssh.on("error", (err) => {
+      if ((err as Error & { level?: string }).level === "client-timeout") {
+        sawKeepaliveTimeout = true;
+      }
+    });
+    this.ssh.once("close", () => {
+      this.deathReason = sawKeepaliveTimeout ? "probe_silent" : "stopped";
+      const waiters = [...this.deathWaiters];
+      this.deathWaiters.clear();
+      for (const waiter of waiters) waiter();
+    });
+  }
 
+  private diedError(operation: string): SandboxDiedError {
+    return new SandboxDiedError({
+      operation,
+      reason: this.deathReason ?? "stopped",
+    });
+  }
+
+  /**
+   * Await an SSH operation while watching for connection death. SSH is the
+   * liveness channel itself: a VM that dies with a TCP reset fails every
+   * in-flight ssh2 callback natively, and a VM that dies silently is caught
+   * by the keepalives configured in sshConnect(), which destroy the socket.
+   * Either way the client emits 'close' and this race rejects with
+   * SandboxDiedError, so a call that is in flight when the VM dies settles
+   * (and is classified as an infrastructure failure) instead of hanging —
+   * or, for exec, resolving as a phantom success when the channel closes
+   * without an exit code.
+   *
+   * There is deliberately no per-command deadline here; a healthy slow
+   * command is never interrupted. When `signal` is provided, its abort
+   * joins the race and rejects immediately even though the remote command
+   * cannot be cancelled mid-flight.
+   *
+   * Channel opens (getSftp) are not raced: ssh2 fails a pending channel
+   * open natively when the connection closes.
+   */
+  private guarded<T>(operation: string, op: Promise<T>, signal?: AbortSignal): Promise<T> {
+    if (signal?.aborted) {
+      // The call is already in flight; swallow its eventual settlement so
+      // the early rejection can't leave an unhandled rejection behind.
+      op.catch(() => {});
+      return Promise.reject(abortError(signal));
+    }
+    if (this.deathReason) {
+      op.catch(() => {});
+      return Promise.reject(this.diedError(operation));
+    }
+    return new Promise<T>((resolve, reject) => {
+      let settled = false;
+      let removeAbortListener = (): void => {};
+
+      const settle = (complete: () => void): void => {
+        if (settled) return;
+        settled = true;
+        this.deathWaiters.delete(onDeath);
+        removeAbortListener();
+        complete();
+      };
+      const onDeath = (): void => settle(() => reject(this.diedError(operation)));
+      this.deathWaiters.add(onDeath);
+
+      if (signal) {
+        const onAbort = (): void => settle(() => reject(abortError(signal)));
+        signal.addEventListener("abort", onAbort, { once: true });
+        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
+      }
+
+      // These handlers double as the losing branch's rejection consumer, so
+      // a late settlement after death or abort can't surface as an
+      // unhandled rejection.
+      op.then(
+        (value) => settle(() => resolve(value)),
+        (error: unknown) => settle(() => reject(error)),
+      );
+    });
+  }
+
   private getSftp(): Promise<SFTPWrapper> {
     if (this.sftpInstance) return Promise.resolve(this.sftpInstance);
     if (this.sftpPromise) return this.sftpPromise;
@@ -419,7 +542,7 @@
 
   async readFile(filePath: string): Promise<string> {
     const sftp = await this.getSftp();
-    return new Promise<string>((resolve, reject) => {
+    const op = new Promise<string>((resolve, reject) => {
       const chunks: Buffer[] = [];
       const stream = sftp.createReadStream(filePath, { encoding: "utf-8" });
       stream.on("data", (chunk: Buffer | string) => {
@@ -428,33 +551,36 @@
       stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
       stream.on("error", reject);
     });
+    return this.guarded("readFile", op);
   }
 
   async readFileBuffer(filePath: string): Promise<Uint8Array> {
     const sftp = await this.getSftp();
-    return new Promise<Uint8Array>((resolve, reject) => {
+    const op = new Promise<Uint8Array>((resolve, reject) => {
       const chunks: Buffer[] = [];
       const stream = sftp.createReadStream(filePath);
       stream.on("data", (chunk: Buffer) => chunks.push(chunk));
       stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
       stream.on("error", reject);
     });
+    return this.guarded("readFile", op);
   }
 
   async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
     const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
     const sftp = await this.getSftp();
-    return new Promise<void>((resolve, reject) => {
+    const op = new Promise<void>((resolve, reject) => {
       const stream = sftp.createWriteStream(filePath);
       stream.on("close", () => resolve());
       stream.on("error", reject);
       stream.end(buf);
     });
+    return this.guarded("writeFile", op);
   }
 
   async stat(filePath: string): Promise<FileStat> {
     const sftp = await this.getSftp();
-    return new Promise<FileStat>((resolve, reject) => {
+    const op = new Promise<FileStat>((resolve, reject) => {
       sftp.stat(filePath, (err, stats) => {
         if (err) return reject(err);
         resolve({
@@ -466,23 +592,27 @@
         });
       });
     });
+    return this.guarded("stat", op);
   }
 
   async readdir(dirPath: string): Promise<string[]> {
     const sftp = await this.getSftp();
-    return new Promise<string[]>((resolve, reject) => {
+    const op = new Promise<string[]>((resolve, reject) => {
       sftp.readdir(dirPath, (err, list) => {
         if (err) return reject(err);
         resolve(list.map((entry) => entry.filename));
       });
     });
+    return this.guarded("readdir", op);
   }
 
   async exists(filePath: string): Promise<boolean> {
     try {
       await this.stat(filePath);
       return true;
-    } catch {
+    } catch (err) {
+      // Sandbox death must reject, not read as "file absent".
+      if (err instanceof SandboxDiedError) throw err;
       return false;
     }
   }
@@ -493,9 +623,10 @@
       return;
     }
     const sftp = await this.getSftp();
-    return new Promise<void>((resolve, reject) => {
+    const op = new Promise<void>((resolve, reject) => {
       sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
     });
+    return this.guarded("mkdir", op);
   }
 
   async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
@@ -511,12 +642,13 @@
       });
     }
     const sftp = await this.getSftp();
-    return new Promise<void>((resolve, reject) => {
+    const op = new Promise<void>((resolve, reject) => {
       sftp.unlink(filePath, (unlinkErr) => {
         if (!unlinkErr) return resolve();
         sftp.rmdir(filePath, (rmdirErr) => (rmdirErr ? reject(rmdirErr) : resolve()));
       });
     });
+    return this.guarded("rm", op);
   }
 
   async exec(
@@ -540,9 +672,11 @@
       cmd = `cd '${shellEscape(options.cwd)}' && ${cmd}`;
     }
 
-    // ssh2 has no AbortSignal integration. The option is accepted for the
-    // SandboxApi shape; Flue's runtime enforces pre/post signal checks.
-    return new Promise((resolve, reject) => {
+    // ssh2 cannot cancel a remote command mid-flight. The signal instead
+    // joins the death watcher's race (see guarded()), so an abort rejects
+    // immediately even though the VM keeps running the command; Flue's
+    // runtime additionally enforces pre/post signal checks.
+    const op = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
       this.ssh.exec(cmd, {}, (err, stream) => {
         if (err) return reject(err);
 
@@ -586,6 +720,7 @@
         });
       });
     });
+    return this.guarded("exec", op, options?.signal);
   }
 }
 
```
