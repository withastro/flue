---
{
  "category": "sandbox",
  "website": "https://exe.dev",
  "aliases": ["exe"]
}
---

# Add a Flue Connector: exe.dev

You are an AI coding agent installing the exe.dev sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout or a
missing required VM hostname).

## What this connector does

Wraps an already-available exe.dev VM into Flue's `SandboxFactory` interface
over SSH + SFTP. The user owns the VM lifecycle; this connector just adapts
the VM.

This connector depends on Node.js APIs and the `ssh2` package, so use it with
Flue's Node target. It is not suitable for Cloudflare Worker-target agents.

exe.dev also exposes an HTTPS API (`POST https://exe.dev/exec`) for VM
lifecycle commands like `new`, `cp`, and `rm`. This guide includes optional
helpers for that setup work, but `exedev(...)` itself only wraps a VM that
already exists.

## Where to write the file

Pick the location based on the user's source layout (analogous to Next.js's
`src/` folder):

- **If `<workspace>/.flue/` exists**, write to `./.flue/connectors/exedev.ts`.
- **Otherwise**, write to `./connectors/exedev.ts` at the workspace root.

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
 * Wraps an already-available exe.dev VM into Flue's SandboxFactory interface
 * using SSH for shell commands and SFTP for file operations.
 *
 * This connector depends on Node.js APIs and the `ssh2` package, so use it
 * with Flue's Node target. It is not suitable for Cloudflare Worker-target
 * agents.
 *
 * Optional lifecycle helpers (`createExeVm`, `cloneExeVm`, `deleteExeVm`)
 * use exe.dev's HTTPS API before/after agent setup. The connector itself
 * does not create, clone, or delete infrastructure.
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
 * @example Create a VM before wrapping it
 * ```typescript
 * import { createExeVm, deleteExeVm, exedev } from './connectors/exedev';
 *
 * const vm = await createExeVm({ apiToken: process.env.EXE_API_TOKEN! });
 * try {
 *   const agent = await init({
 *     sandbox: exedev(vm),
 *     model: 'anthropic/claude-sonnet-4-6',
 *   });
 * } finally {
 *   await deleteExeVm({ apiToken: process.env.EXE_API_TOKEN!, name: vm.name });
 * }
 * ```
 */
import { createSandboxSessionEnv } from "@flue/sdk/sandbox";
import type {
  FileStat,
  SandboxApi,
  SandboxFactory,
  SessionEnv,
} from "@flue/sdk/sandbox";
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

export interface ExeDevConnectorOptions {
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
  ssh?: ExeDevConnectorOptions;
}

export interface CloneExeVmOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** Source VM name to clone with `cp <source>`. */
  source: string;
  /** How long to wait for SSH after clone. Defaults to 90000ms. */
  readyTimeoutMs?: number;
  /** SSH options used for the readiness check. */
  ssh?: ExeDevConnectorOptions;
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
  options?: ExeDevConnectorOptions,
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

/** Resolve SSH auth — either a private key (file/buffer) or an agent socket. */
export function resolveAuth(
  opts: ExeDevConnectorOptions,
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
  opts: ExeDevConnectorOptions,
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
  opts: ExeDevConnectorOptions,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const ssh = new SSHClient();
  const config: ConnectConfig = {
    host: vm.host,
    port: opts.port ?? vm.port ?? 22,
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

export interface SshLike {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
  exec(
    command: string,
    options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ): unknown;
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

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
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

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      await this.exec(`mkdir -p '${shellEscape(dirPath)}'`);
      return;
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
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
        sftp.rmdir(filePath, (rmdirErr) => (rmdirErr ? reject(rmdirErr) : resolve()));
      });
    });
  }

  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
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

    return new Promise((resolve, reject) => {
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

        if (options?.timeout) {
          timer = setTimeout(() => {
            stream.close();
            finish({
              stdout,
              stderr: `${stderr}\n[flue:exedev] Command timed out after ${options.timeout} seconds.`,
              exitCode: 124,
            });
          }, options.timeout * 1000);
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
  }
}

export function exedev(vm: ExeDevVm | string, options?: ExeDevConnectorOptions): SandboxFactory {
  const resolvedVm = typeof vm === "string" ? { host: vm } : vm;
  return {
    async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
      const { ssh } = await sshConnect(resolvedVm, options ?? {});
      const api = new ExeDevSandboxApi(ssh);

      let sandboxCwd = cwd ?? "/home/user";
      if (!cwd) {
        try {
          const { stdout } = await api.exec("echo $HOME");
          const detected = stdout.trim();
          if (detected) sandboxCwd = detected;
        } catch {
          // Fall back to /home/user.
        }
      }

      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

## Required dependencies

This connector imports from Node.js built-ins and `ssh2`, so it requires
Flue's Node target and the user's project needs to depend on `ssh2` directly.
If their `package.json` does not already list it, add it:

```bash
npm install ssh2
npm install -D @types/ssh2
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

SSH is always required. The connector auto-detects SSH auth in this order:

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

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share the relevant snippet so they can wire it up themselves.

### Existing VM

Use this by default. If the user did not provide a VM hostname and there is
no obvious project convention like `EXE_VM_HOST`, ask for the exe.dev VM
hostname before wiring the connector.

```ts
import type { FlueContext } from "@flue/sdk/client";
import { exedev } from "../connectors/exedev";

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const agent = await init({
    sandbox: exedev({ host: env.EXE_VM_HOST }),
    model: "anthropic/claude-sonnet-4-6",
  });
  const session = await agent.session();

  return await session.shell("uname -a");
}
```

### Fresh VM

Only use this when the user explicitly asks to create a VM and provides an
API token with `new` permission. The VM is created before `init(...)` and
then passed to `exedev(...)`.

```ts
import type { FlueContext } from "@flue/sdk/client";
import { createExeVm, deleteExeVm, exedev } from "../connectors/exedev";

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const vm = await createExeVm({ apiToken: env.EXE_API_TOKEN });

  try {
    const agent = await init({
      sandbox: exedev(vm),
      model: "anthropic/claude-sonnet-4-6",
    });
    const session = await agent.session();

    return await session.shell("uname -a");
  } finally {
    await deleteExeVm({ apiToken: env.EXE_API_TOKEN, name: vm.name });
  }
}
```

### Cloned VM

Only use this when the user explicitly asks to clone a base VM and provides
an API token with `cp` permission. If you delete the clone afterwards, the
token also needs `rm` permission.

```ts
import type { FlueContext } from "@flue/sdk/client";
import { cloneExeVm, deleteExeVm, exedev } from "../connectors/exedev";

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const vm = await cloneExeVm({
    apiToken: env.EXE_API_TOKEN,
    source: "my-dev-vm",
  });

  try {
    const agent = await init({
      sandbox: exedev(vm),
      model: "anthropic/claude-sonnet-4-6",
    });
    const session = await agent.session();

    return await session.shell("uname -a");
  } finally {
    await deleteExeVm({ apiToken: env.EXE_API_TOKEN, name: vm.name });
  }
}
```

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm `ssh user@<vm-host> echo hello` works for existing-VM mode.
3. Confirm the import path you used for the connector matches where you
   actually wrote the file.
4. Tell the user the next steps: install `ssh2` and `@types/ssh2` (if you
   didn't), make sure the needed exe.dev SSH/API values are available at
   runtime (per the Authentication section above), and run `flue dev --target node`
   (or `flue run <agent> --target node`) to try it.
