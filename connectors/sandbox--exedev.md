---
{ "category": "sandbox", "website": "https://exe.dev" }
---

# Add a Flue Connector: exe.dev

You are an AI coding agent installing the exe.dev sandbox connector for a
Flue project. Follow the steps. Confirm with the user only on genuine
ambiguity.

## What this connector does

Wraps an exe.dev VM into Flue's `SandboxFactory` over:

- **SSH + SFTP** to `<vmname>.exe.xyz` for shell + file I/O
- **HTTPS** (`POST https://exe.dev/exec`) for VM lifecycle (`new`, `cp`, `rm`)

VMs are persistent. `cleanup: true` only closes SSH and deletes
auto-created VMs; it never touches VMs passed via `host`.

For `createVm` and `cloneFrom`, the connector waits up to 90s after the
HTTPS API returns for DNS to propagate and sshd to come up — no manual
sleep needed in your agent code.

## Choose a mode

Ask the user which one. Default to **Existing VM**.

| Mode            | Option             | Use when                                               |
| --------------- | ------------------ | ------------------------------------------------------ |
| **Existing VM** | `host: '...'`      | Long-running assistant, dev/build agent. **Default.**  |
| **Cloned VM**   | `cloneFrom: '...'` | Ephemeral per-run isolation off a pre-configured base. |
| **Fresh VM**    | `createVm: true`   | Clean slate every time. Rarely the right choice.       |

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/exedev.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/exedev.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * exe.dev connector for Flue.
 *
 * Wraps an exe.dev VM into Flue's SandboxFactory interface using two channels:
 *
 *   1. **SSH + SFTP** (to `<vmname>.exe.xyz`) for SandboxApi — running shell
 *      commands and reading/writing files inside the VM.
 *   2. **HTTPS API** (`POST https://exe.dev/exec`) for optional VM lifecycle —
 *      creating/deleting VMs on the fly.
 *
 * The HTTPS API is the SSH CLI shoved into a POST body. It runs exe.dev
 * commands (`new`, `rm`, `ls`, `cp`, `restart`, etc.), not shell commands
 * inside the VM. Auth uses bearer tokens signed with your SSH key.
 *
 * @example Existing VM (most common)
 * ```typescript
 * import { exedev } from './connectors/exedev';
 *
 * const agent = await init({
 *   sandbox: exedev({ host: 'maple-dune.exe.xyz' }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Create a fresh VM per session
 * ```typescript
 * import { exedev } from './connectors/exedev';
 *
 * const agent = await init({
 *   sandbox: exedev({
 *     apiToken: process.env.EXE_API_TOKEN!,
 *     createVm: true,   // runs `new` via HTTPS API
 *     cleanup: true,     // runs `rm` on session destroy
 *   }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Clone an existing VM as a sandbox
 * ```typescript
 * import { exedev } from './connectors/exedev';
 *
 * const agent = await init({
 *   sandbox: exedev({
 *     apiToken: process.env.EXE_API_TOKEN!,
 *     cloneFrom: 'my-dev-vm',   // runs `cp my-dev-vm` via HTTPS API
 *     cleanup: true,
 *   }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 */
import { createSandboxSessionEnv } from "@flue/sdk/sandbox";
import type {
  SandboxApi,
  SandboxFactory,
  SessionEnv,
  FileStat,
} from "@flue/sdk/sandbox";
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface ExeDevConnectorOptions {
  /**
   * The VM hostname to connect to, e.g. "maple-dune.exe.xyz".
   * Required unless `createVm` or `cloneFrom` is set.
   */
  host?: string;

  /** SSH username on the VM. Defaults to "user" (exeuntu default). */
  username?: string;

  /** SSH port. Defaults to 22. */
  port?: number;

  /**
   * SSH private key as a raw PEM string or Buffer.
   * If omitted, falls back to `privateKeyPath`, then `$EXE_SSH_KEY`,
   * then ~/.ssh/id_ed25519, then ~/.ssh/id_rsa.
   */
  privateKey?: string | Buffer;

  /**
   * Path to an SSH private key file. Overrides `$EXE_SSH_KEY` and the
   * default ~/.ssh lookups, but is overridden by `privateKey`.
   */
  privateKeyPath?: string;

  /**
   * Path to an SSH agent socket (e.g. 1Password's agent, ssh-agent,
   * a Yubikey-backed agent). When set, the connector authenticates
   * via the agent instead of a private key file.
   *
   * If unset, the connector still falls back to `$SSH_AUTH_SOCK` when
   * no private key can be resolved — useful when the key only lives
   * in an agent (1Password "store-only" SSH keys).
   */
  agent?: string;

  /**
   * exe.dev HTTPS API bearer token (exe0.* or exe1.*).
   *
   * Required when `createVm` or `cloneFrom` is set. Generate one by:
   *
   *   ssh-keygen -t ed25519 -C api -f ~/.ssh/exe_dev_api
   *   cat ~/.ssh/exe_dev_api.pub | ssh exe.dev ssh-key add
   *   # Sign permissions & assemble token (see exe.dev/docs/https-api)
   *
   * The token's `cmds` must include "new", "rm", and/or "cp" depending
   * on which lifecycle features you use.
   */
  apiToken?: string;

  /**
   * Create a fresh VM via `POST https://exe.dev/exec` with command `new`.
   * Requires `apiToken`.
   */
  createVm?: boolean;

  /** VM name when creating. If omitted, exe.dev generates a random name. */
  vmName?: string;

  /**
   * Clone an existing VM instead of creating from scratch.
   * Runs `cp <cloneFrom>` via the HTTPS API. Requires `apiToken`.
   */
  cloneFrom?: string;

  /**
   * Cleanup behavior when the session is destroyed.
   *
   * - `false` (default): No cleanup. exe.dev VMs are persistent — the
   *   user manages the VM lifecycle via `ssh exe.dev` → `rm`.
   * - `true`: Closes SSH. If the VM was auto-created/cloned, also runs
   *   `rm <vmname>` via the HTTPS API.
   * - Function: Calls the provided function, then closes SSH (and
   *   deletes auto-created VMs).
   */
  cleanup?: boolean | (() => Promise<void>);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by the exe.dev connector. Use `instanceof ExeDevError` to
 * distinguish connector errors from upstream Flue / ssh2 errors.
 */
export class ExeDevError extends Error {
  override name = "ExeDevError";
  constructor(message: string) {
    super(message);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, ExeDevError);
    }
  }
}

// ---------------------------------------------------------------------------
// exe.dev HTTPS API client (VM control plane)
// ---------------------------------------------------------------------------

const EXE_API_URL = "https://exe.dev/exec";

/**
 * Run an exe.dev CLI command via the HTTPS API.
 *
 * Body is the command string exactly as you'd type it in the SSH REPL.
 * API limits: 30s timeout (504), 64KB body (413), no stdin, no pty.
 * See: https://exe.dev/docs/https-api
 */
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

/**
 * Resolved VM info from a `new` or `cp` HTTPS API response.
 */
interface ApiVmInfo {
  /** VM name (used later for `rm` cleanup). */
  name: string;
  /** SSH destination hostname — taken from `ssh_dest` when available. */
  host: string;
}

/**
 * Parse the JSON body from a `new` / `cp` HTTPS API call.
 *
 * The exe.dev API returns `{vm_name, ssh_dest, ssh_port, ...}`. We prefer
 * `ssh_dest` over re-deriving `${name}.exe.xyz` so the API stays
 * authoritative for hostname mapping.
 *
 * @internal exported for tests
 */
export function parseVmResponse(output: string): ApiVmInfo {
  let data: {
    vm_name?: unknown;
    name?: unknown;
    vm?: unknown;
    ssh_dest?: unknown;
  };
  try {
    data = JSON.parse(output);
  } catch {
    throw new ExeDevError(
      "exe.dev HTTPS API returned non-JSON output:\n" +
        `  ${output.slice(0, 200)}`,
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
  return { name, host };
}

/**
 * Create a VM via HTTPS API (`new [name]`).
 */
async function apiCreateVm(token: string, name?: string): Promise<ApiVmInfo> {
  const cmd = name ? `new ${name}` : "new";
  return parseVmResponse(await exeApi(token, cmd));
}

/**
 * Clone a VM via HTTPS API (`cp <source>`).
 */
async function apiCloneVm(token: string, source: string): Promise<ApiVmInfo> {
  return parseVmResponse(await exeApi(token, `cp ${source}`));
}

/**
 * Delete a VM via HTTPS API (`rm <name>`). Best-effort, logs errors.
 */
async function apiDeleteVm(token: string, name: string): Promise<void> {
  try {
    await exeApi(token, `rm ${name}`);
  } catch (err) {
    console.error("[flue:exedev] Failed to delete VM:", err);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe use inside single-quoted shell args. */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Resolve SSH auth — either a private key (file/buffer) or an agent socket.
 *
 * Order:
 *   1. `privateKey` option (raw PEM)             → key
 *   2. `agent` option                            → agent
 *   3. `privateKeyPath` option (file)            → key
 *   4. `$EXE_SSH_KEY` env var (file)             → key
 *   5. `~/.ssh/id_ed25519` / `~/.ssh/id_rsa`     → key
 *   6. `$SSH_AUTH_SOCK` env var                  → agent (last-resort fallback)
 *
 * Step 6 covers 1Password / ssh-agent / Yubikey users whose private keys
 * never touch the filesystem.
 *
 * @internal exported for tests
 */
export function resolveAuth(
  opts: ExeDevConnectorOptions,
  env: NodeJS.ProcessEnv = process.env,
): { privateKey?: string | Buffer; agent?: string } {
  if (opts.privateKey) return { privateKey: opts.privateKey };
  if (opts.agent) return { agent: opts.agent };

  const tried: { source: string; path: string; reason: string }[] = [];

  const tryPath = (
    keyPath: string,
    source: string,
  ): string | Buffer | undefined => {
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

  // Last resort: if an SSH agent is running, use it. Covers 1Password and
  // other "key never on disk" setups.
  if (env.SSH_AUTH_SOCK) return { agent: env.SSH_AUTH_SOCK };

  const triedLines =
    tried.length > 0
      ? tried
          .map((t) => `    - ${t.path} (${t.source}, ${t.reason})`)
          .join("\n")
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

/**
 * Errors that mean "the VM isn't reachable yet" — DNS hasn't propagated,
 * sshd isn't listening, network not yet routable. Safe to retry.
 *
 * Auth failures, host-key mismatches, and other terminal errors are NOT
 * retryable — those would spin forever.
 *
 * @internal exported for tests
 */
const RETRYABLE_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** @internal exported for tests */
export function isRetryableSshError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof e.code === "string" && RETRYABLE_ERROR_CODES.has(e.code))
    return true;
  if (typeof e.errno === "string" && RETRYABLE_ERROR_CODES.has(e.errno))
    return true;
  if (
    typeof e.message === "string" &&
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(
      e.message,
    )
  ) {
    return true;
  }
  return false;
}

/** Default budget for waiting on a freshly-created VM to become SSH-able. */
const DEFAULT_VM_READY_TIMEOUT_MS = 90_000;

/**
 * Connect to a VM that may still be coming up. Retries transient errors
 * (DNS, connection refused, ...) on a 1s interval until `deadlineMs` passes.
 */
async function sshConnectWithRetry(
  host: string,
  opts: ExeDevConnectorOptions,
  deadlineMs: number,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const start = Date.now();
  let lastErr: unknown;
  while (true) {
    try {
      return await sshConnect(host, opts);
    } catch (err) {
      lastErr = err;
      if (!isRetryableSshError(err)) throw err;
      if (Date.now() - start > deadlineMs) {
        throw new ExeDevError(
          `Timed out after ${Math.round((Date.now() - start) / 1000)}s waiting ` +
            `for ${host} to become SSH-able.\n` +
            `  Last error: ${(lastErr as Error)?.message ?? String(lastErr)}\n` +
            `  The VM may still be booting, or the API token's 'cmds' may be missing 'new'/'cp'.`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Open SSH to a VM. Returns the client and a disconnect function.
 *
 * SFTP is opened lazily by ExeDevSandboxApi on first file op — agents that
 * only call `exec`/`shell` never open the SFTP subsystem and can't trip
 * server-side idle-channel termination.
 */
async function sshConnect(
  host: string,
  opts: ExeDevConnectorOptions,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const ssh = new SSHClient();
  const config: ConnectConfig = {
    host,
    port: opts.port ?? 22,
    username: opts.username ?? "user",
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

// ---------------------------------------------------------------------------
// SandboxApi implementation
// ---------------------------------------------------------------------------

/**
 * Minimal subset of SSHClient that ExeDevSandboxApi actually uses.
 * Lets unit tests pass a fake without depending on ssh2 internals.
 *
 * @internal
 */
export interface SshLike {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
  exec(
    command: string,
    options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ): unknown;
}

/** @internal */
export interface SshExecStream {
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  stderr: { on(event: "data", listener: (data: Buffer) => void): unknown };
  close(): void;
}

/**
 * Implements SandboxApi over SSH + SFTP to an exe.dev VM.
 *
 * File operations use SFTP (efficient, binary-safe). Shell operations use
 * SSH exec. Recursive mkdir and rm fall back to shell commands since SFTP
 * doesn't support them natively (same pattern as the Daytona connector).
 *
 * SFTP is opened lazily on first file op. If the server tears down the
 * SFTP channel (e.g. idle timeout), the cache is dropped and the next
 * file op re-opens. Crucially, attaching `error`/`close` listeners on the
 * SFTP wrapper prevents "Received unexpected SFTP session termination"
 * from surfacing as an unhandled error in shell-only or long-idle flows.
 *
 * @internal exported for tests
 */
export class ExeDevSandboxApi implements SandboxApi {
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;

  constructor(private ssh: SshLike) {}

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

  // -- File operations (SFTP) ----------------------------------------------

  async readFile(filePath: string): Promise<string> {
    const sftp = await this.getSftp();
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath, { encoding: "utf-8" });
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const sftp = await this.getSftp();
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath);
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", reject);
    });
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const buf =
      typeof content === "string"
        ? Buffer.from(content, "utf-8")
        : Buffer.from(content);
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on("close", () => resolve());
      stream.on("error", reject);
      stream.end(buf);
    });
  }

  async stat(filePath: string): Promise<FileStat> {
    const sftp = await this.getSftp();
    return new Promise<FileStat>((resolve, reject) => {
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
  }

  async readdir(dirPath: string): Promise<string[]> {
    const sftp = await this.getSftp();
    return new Promise<string[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((entry) => entry.filename));
      });
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    if (options?.recursive) {
      await this.exec(`mkdir -p '${shellEscape(dirPath)}'`);
      return;
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rm(
    filePath: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    let flags = "";
    if (options?.recursive) flags += "r";
    if (options?.force) flags += "f";
    if (flags) {
      await this.exec(`rm -${flags} '${shellEscape(filePath)}'`);
      return;
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(filePath, (unlinkErr) => {
        if (!unlinkErr) return resolve();
        sftp.rmdir(filePath, (rmdirErr) =>
          rmdirErr ? reject(rmdirErr) : resolve(),
        );
      });
    });
  }

  // -- Shell execution (SSH) -----------------------------------------------

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let cmd = command;

    if (options?.env && Object.keys(options.env).length > 0) {
      const envPrefix = Object.entries(options.env)
        .map(([k, v]) => `export ${k}='${shellEscape(v)}'`)
        .join("; ");
      cmd = `${envPrefix}; ${cmd}`;
    }
    if (options?.cwd) {
      cmd = `cd '${shellEscape(options.cwd)}' && ${cmd}`;
    }

    return new Promise((resolve, reject) => {
      this.ssh.exec(cmd, {}, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (options?.timeout) {
          timer = setTimeout(() => {
            stream.close();
            resolve({
              stdout,
              stderr: stderr + "\n[exedev] command timed out",
              exitCode: 124,
            });
          }, options.timeout);
        }

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", (code: number) => {
          if (timer) clearTimeout(timer);
          exitCode = code ?? 0;
          resolve({ stdout, stderr, exitCode });
        });
        stream.on("error", (streamErr: Error) => {
          if (timer) clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Flue sandbox factory backed by an exe.dev VM.
 *
 * **Existing VM** — pass `host` (e.g. `"maple-dune.exe.xyz"`).
 *
 * **Fresh VM** — pass `apiToken` + `createVm: true`. Runs `new` via
 * `POST https://exe.dev/exec`, then SSHs into the new VM.
 *
 * **Cloned VM** — pass `apiToken` + `cloneFrom: "source-vm"`. Runs
 * `cp source-vm` via the HTTPS API, then SSHs into the clone.
 *
 * exe.dev VMs are persistent by design. `cleanup: true` closes the SSH
 * connection and deletes auto-created/cloned VMs. It never touches VMs
 * passed via `host`.
 */
export function exedev(options: ExeDevConnectorOptions): SandboxFactory {
  return {
    async createSessionEnv({
      cwd,
    }: {
      id: string;
      cwd?: string;
    }): Promise<SessionEnv> {
      // ---------------------------------------------------------------
      // 1. Resolve the VM
      // ---------------------------------------------------------------
      let vmHost = options.host;
      let vmName: string | undefined;
      let wasAutoCreated = false;

      if (options.cloneFrom) {
        if (!options.apiToken) {
          throw new ExeDevError(
            "`cloneFrom` needs an `apiToken`.\n" +
              "  Generate one: https://exe.dev/docs/https-api\n" +
              "  Then pass it as `apiToken` to exedev().",
          );
        }
        const info = await apiCloneVm(options.apiToken, options.cloneFrom);
        vmName = info.name;
        vmHost = info.host;
        wasAutoCreated = true;
      } else if (options.createVm) {
        if (!options.apiToken) {
          throw new ExeDevError(
            "`createVm: true` needs an `apiToken`.\n" +
              "  Generate one: https://exe.dev/docs/https-api\n" +
              "  Then pass it as `apiToken` to exedev().",
          );
        }
        const info = await apiCreateVm(options.apiToken, options.vmName);
        vmName = info.name;
        vmHost = info.host;
        wasAutoCreated = true;
      }

      if (!vmHost) {
        throw new ExeDevError(
          "No VM specified.\n" +
            "  Pass one of:\n" +
            '    - `host: "<vm>.exe.xyz"` to use an existing VM\n' +
            "    - `createVm: true` (with `apiToken`) to make a fresh VM\n" +
            '    - `cloneFrom: "<vm>"` (with `apiToken`) to clone a VM',
        );
      }

      // ---------------------------------------------------------------
      // 2. SSH + SFTP into the VM
      //
      // Auto-created/cloned VMs may take a few seconds before DNS resolves
      // and sshd starts accepting connections. Retry transient errors for
      // up to 90s. For user-supplied `host:` values we assume the VM is
      // already up and connect once.
      // ---------------------------------------------------------------
      const { ssh, disconnect } = wasAutoCreated
        ? await sshConnectWithRetry(
            vmHost,
            options,
            DEFAULT_VM_READY_TIMEOUT_MS,
          )
        : await sshConnect(vmHost, options);
      const api = new ExeDevSandboxApi(ssh);

      // ---------------------------------------------------------------
      // 3. Detect working directory
      // ---------------------------------------------------------------
      let sandboxCwd = cwd ?? "/home/user";
      if (!cwd) {
        try {
          const { stdout } = await api.exec("echo $HOME");
          const detected = stdout.trim();
          if (detected) sandboxCwd = detected;
        } catch {
          // fall back to /home/user
        }
      }

      // ---------------------------------------------------------------
      // 4. Wire up cleanup
      // ---------------------------------------------------------------
      let cleanupFn: (() => Promise<void>) | undefined;

      if (options.cleanup === true) {
        cleanupFn = async () => {
          try {
            disconnect();
          } catch (err) {
            console.error("[flue:exedev] SSH disconnect failed:", err);
          }
          if (wasAutoCreated && vmName && options.apiToken) {
            await apiDeleteVm(options.apiToken, vmName);
          }
        };
      } else if (typeof options.cleanup === "function") {
        const userCleanup = options.cleanup;
        cleanupFn = async () => {
          try {
            await userCleanup();
          } catch (err) {
            console.error("[flue:exedev] cleanup function failed:", err);
          } finally {
            disconnect();
            if (wasAutoCreated && vmName && options.apiToken) {
              await apiDeleteVm(options.apiToken, vmName);
            }
          }
        };
      }

      return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
    },
  };
}
```

## Install dependencies

```bash
npm install ssh2
npm install -D @types/ssh2
```

Use the user's package manager (`pnpm`, `yarn`, etc.) per their lockfile.

## Authentication

**SSH (always required):** key-based auth or SSH agent. Auto-detected in order:

1. `privateKey` option (raw PEM)
2. `agent` option (socket path)
3. `privateKeyPath` option (file path)
4. `$EXE_SSH_KEY` env var (file path)
5. `~/.ssh/id_ed25519`
6. `~/.ssh/id_rsa`
7. `$SSH_AUTH_SOCK` env var (last-resort agent fallback)

Step 7 covers 1Password / Yubikey users whose private keys never touch
disk — set nothing and the connector picks up the running agent.

Same keys you registered when first running `ssh exe.dev`.

**HTTPS API token (only for `createVm` / `cloneFrom`):** generate with:

```bash
ssh-keygen -t ed25519 -C api -f ~/.ssh/exe_dev_api
cat ~/.ssh/exe_dev_api.pub | ssh exe.dev ssh-key add

b64url() { tr -d '\n=' | tr '+/' '-_'; }
PERMISSIONS='{"cmds":["new","rm","cp","ls","whoami"]}'
PAYLOAD=$(printf '%s' "$PERMISSIONS" | base64 | b64url)
SIG=$(printf '%s' "$PERMISSIONS" | ssh-keygen -Y sign -f ~/.ssh/exe_dev_api -n v0@exe.dev)
SIGBLOB=$(echo "$SIG" | sed '1d;$d' | b64url)
TOKEN="exe0.$PAYLOAD.$SIGBLOB"

curl -X POST https://exe.dev/exec -H "Authorization: Bearer $TOKEN" -d 'whoami'
```

Default token `cmds` includes `new` but not `rm`/`cp` — override as
above when you need lifecycle management.

Never invent a token value. It must come from the user.

## Wiring

### Existing VM

```ts
import type { FlueContext } from "@flue/sdk/client";
import { exedev } from "../connectors/exedev";

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const agent = await init({
    sandbox: exedev({ host: env.EXE_VM_HOST, cleanup: true }),
    model: "anthropic/claude-sonnet-4-6",
  });
  return await (await agent.session()).shell("uname -a");
}
```

### Fresh VM

```ts
const agent = await init({
  sandbox: exedev({
    apiToken: env.EXE_API_TOKEN,
    createVm: true,
    cleanup: true,
  }),
  model: "anthropic/claude-sonnet-4-6",
});
```

### Cloned VM

```ts
const agent = await init({
  sandbox: exedev({
    apiToken: env.EXE_API_TOKEN,
    cloneFrom: "my-dev-vm",
    cleanup: true,
  }),
  model: "anthropic/claude-sonnet-4-6",
});
```

## All connector options

| Option           | Type                             | Default  | Notes                                                                      |
| ---------------- | -------------------------------- | -------- | -------------------------------------------------------------------------- |
| `host`           | `string`                         | —        | VM hostname. Required unless `createVm` or `cloneFrom` is set.             |
| `username`       | `string`                         | `"user"` | SSH username on the VM (exeuntu default).                                  |
| `port`           | `number`                         | `22`     | SSH port.                                                                  |
| `privateKey`     | `string \| Buffer`               | —        | Raw PEM. Highest precedence in the SSH-key resolution chain.               |
| `privateKeyPath` | `string`                         | —        | Path to a private-key file. Beats `$EXE_SSH_KEY` and `~/.ssh/*`.           |
| `agent`          | `string`                         | —        | SSH agent socket path. Beats file lookups; falls back to `$SSH_AUTH_SOCK`. |
| `apiToken`       | `string`                         | —        | exe.dev HTTPS bearer token. Required for `createVm` / `cloneFrom`.         |
| `createVm`       | `boolean`                        | `false`  | Create a fresh VM via `new`. Needs `apiToken`.                             |
| `vmName`         | `string`                         | random   | VM name when `createVm: true`. Omit to let exe.dev generate one.           |
| `cloneFrom`      | `string`                         | —        | Clone a VM via `cp <name>`. Needs `apiToken`.                              |
| `cleanup`        | `boolean \| () => Promise<void>` | `false`  | See cleanup behavior below.                                                |

### Cleanup behavior

- `false` (default) — no cleanup. exe.dev VMs are persistent; user manages lifecycle via `ssh exe.dev` → `rm`.
- `true` — closes SSH. Also `rm`s the VM when it was auto-created via `createVm` / `cloneFrom`. Never deletes a VM passed via `host`.
- function — runs the user function, then closes SSH (and deletes auto-created VMs).

## Environment variables

| Variable        | Required                     | Description                                                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `EXE_VM_HOST`   | for existing VM              | e.g. `maple-dune.exe.xyz`. Convention only; passed by user.                                      |
| `EXE_API_TOKEN` | for `createVm` / `cloneFrom` | bearer token (`exe0.*` / `exe1.*`). Convention only.                                             |
| `EXE_SSH_KEY`   | optional                     | Path to SSH private key. Used as a fallback by the connector.                                    |
| `SSH_AUTH_SOCK` | optional                     | SSH agent socket. Picked up automatically when no key file resolves (1Password, ssh-agent, ...). |

Place vars per project conventions (`.env`, `.dev.vars`, `AGENTS.md`).
Ask if unclear.

## Verify

1. `npx tsc --noEmit` — no type errors
2. `ssh user@<vm-host> echo hello` — SSH works
3. Tell the user: deps installed, env set, run `flue dev` or `flue run <agent>`
