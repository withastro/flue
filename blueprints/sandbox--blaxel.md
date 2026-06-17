---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://blaxel.ai",
  "aliases": ["@blaxel/core"]
}
---

# Add a Flue Sandbox Adapter: Blaxel

You are an AI coding agent installing the Blaxel sandbox adapter for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous, such as an unusual project layout or an
application that needs to own sandbox creation elsewhere.

## What this adapter does

Wraps an already-initialized Blaxel `SandboxInstance` from `@blaxel/core` into
Flue's `SandboxFactory` interface. The user owns Blaxel authentication, sandbox
creation, image selection, retention, and deletion. This adapter only maps the
existing sandbox to Flue's file and shell session surface.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/blaxel.ts`.

If neither feels right, ask the user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it. It conforms to the published
`SandboxApi` contract and keeps Blaxel sandbox lifecycle outside the adapter.

```ts
// flue-blueprint: sandbox/blaxel@1
/**
 * Blaxel adapter for Flue.
 *
 * Wraps an already-initialized Blaxel SandboxInstance into Flue's
 * SandboxFactory interface. The application creates, configures, retains, and
 * deletes the sandbox through @blaxel/core; Flue just receives a session env.
 *
 * @example
 * ```typescript
 * import { SandboxInstance } from '@blaxel/core';
 * import { createAgent } from '@flue/runtime';
 * import { blaxel } from './sandboxes/blaxel';
 *
 * const sandbox = await SandboxInstance.createIfNotExists({
 *   name: 'flue-blaxel',
 *   image: 'blaxel/base-image:latest',
 *   memory: 4096,
 *   region: process.env.BL_REGION ?? 'us-pdx-1',
 * });
 *
 * const agent = createAgent(() => ({
 *   sandbox: blaxel(sandbox),
 *   model: 'anthropic/claude-sonnet-4-6',
 * }));
 * ```
 */
import type { SandboxInstance } from "@blaxel/core";
import { randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import {
  createSandboxSessionEnv,
  type FileStat,
  type SandboxApi,
  type SandboxFactory,
  type ShellResult,
  type SessionEnv
} from "@flue/runtime";

type ExecOptions = Parameters<SandboxApi["exec"]>[1];
type MkdirOptions = Parameters<SandboxApi["mkdir"]>[1];
type RmOptions = Parameters<SandboxApi["rm"]>[1];
type BlaxelDirectory = Awaited<ReturnType<SandboxInstance["fs"]["ls"]>>;
type BlaxelFile = BlaxelDirectory["files"][number];
type BlaxelSubdirectory = BlaxelDirectory["subdirectories"][number];
type BlaxelProcessResult = Awaited<ReturnType<SandboxInstance["process"]["exec"]>>;
type BlaxelWaitResult = Awaited<ReturnType<SandboxInstance["process"]["wait"]>>;

export interface BlaxelSandboxOptions {
  cwd?: string;
}

export function blaxel(
  sandbox: SandboxInstance,
  options: BlaxelSandboxOptions = {}
): SandboxFactory {
  const cwd = options.cwd ?? "/tmp";
  const api = new BlaxelSandboxApi(sandbox);

  return {
    async createSessionEnv(_options: { id: string }): Promise<SessionEnv> {
      return createSandboxSessionEnv(api, cwd);
    }
  };
}

export class BlaxelSandboxApi implements SandboxApi {
  constructor(private readonly sandbox: SandboxInstance) {}

  async readFile(filePath: string): Promise<string> {
    return this.sandbox.fs.read(normalizeSandboxPath(filePath));
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const blob = await this.sandbox.fs.readBinary(normalizeSandboxPath(filePath));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async writeFile(
    filePath: string,
    data: string | Uint8Array
  ): Promise<void> {
    const normalizedPath = normalizeSandboxPath(filePath);
    if (typeof data === "string") {
      await this.sandbox.fs.write(normalizedPath, data);
      return;
    }

    await this.sandbox.fs.writeBinary(normalizedPath, data);
  }

  async stat(filePath: string): Promise<FileStat> {
    const normalizedPath = normalizeSandboxPath(filePath);

    if (await this.isDirectory(normalizedPath)) {
      return { isFile: false, isDirectory: true };
    }

    const parentPath = path.dirname(normalizedPath);
    const entryName = path.basename(normalizedPath);

    try {
      const parent = await this.sandbox.fs.ls(parentPath);
      const file = parent.files.find((candidate) => candidate.name === entryName);
      if (file) {
        return fileStat(file);
      }

      const subdirectory = parent.subdirectories.find(
        (candidate) => candidate.name === entryName
      );
      if (subdirectory) {
        return directoryStat(subdirectory);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    throw new BlaxelPathNotFoundError(normalizedPath);
  }

  async readdir(directoryPath: string): Promise<string[]> {
    const directory = await this.sandbox.fs.ls(normalizeSandboxPath(directoryPath));
    return [
      ...directory.files.map((file) => file.name),
      ...directory.subdirectories.map((subdirectory) => subdirectory.name)
    ];
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async mkdir(directoryPath: string, options?: MkdirOptions): Promise<void> {
    const normalizedPath = normalizeSandboxPath(directoryPath);
    if (!options?.recursive) {
      await this.sandbox.fs.mkdir(normalizedPath);
      return;
    }

    await this.mkdirRecursive(normalizedPath);
  }

  async rm(
    filePath: string,
    options?: RmOptions
  ): Promise<void> {
    const normalizedPath = normalizeSandboxPath(filePath);
    try {
      await this.sandbox.fs.rm(normalizedPath, Boolean(options?.recursive));
    } catch (error) {
      if (options?.force && isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async exec(
    command: string,
    options?: ExecOptions
  ): Promise<ShellResult> {
    throwIfAborted(options?.signal);

    if (!options?.timeoutMs || options.timeoutMs <= 60_000) {
      let result: BlaxelProcessResult;
      try {
        result = await this.sandbox.process.exec({
          command,
          env: options?.env,
          name: processName(),
          timeout: timeoutSeconds(options?.timeoutMs),
          waitForCompletion: true,
          workingDir: options?.cwd
        });
      } catch (error) {
        if (isProcessTimeoutError(error)) {
          return timeoutResult(options?.timeoutMs);
        }
        throw error;
      }
      throwIfAborted(options?.signal);
      return shellResult(result);
    }

    return this.execLongRunning(command, options);
  }

  private async execLongRunning(
    command: string,
    options: NonNullable<ExecOptions>
  ): Promise<ShellResult> {
    const name = processName();
    const started = await this.sandbox.process.exec({
      command,
      env: options.env,
      name,
      timeout: timeoutSeconds(options.timeoutMs),
      waitForCompletion: false,
      workingDir: options.cwd
    });

    throwIfAborted(options.signal);

    const removeAbortListener = this.attachKillOnAbort(name, options.signal);
    try {
      const result = await this.waitForProcess(name, options.timeoutMs);
      throwIfAborted(options.signal);
      return await this.shellResultWithLogs(result, started);
    } finally {
      removeAbortListener();
    }
  }

  private async waitForProcess(
    name: string,
    timeoutMs: number | undefined
  ): Promise<BlaxelWaitResult> {
    try {
      return await this.sandbox.process.wait(name, {
        interval: 1000,
        maxWait: timeoutMs
      });
    } catch (error) {
      if (isWaitTimeoutError(error)) {
        await this.sandbox.process.kill(name).catch(() => undefined);
        return {
          command: "",
          completedAt: new Date().toISOString(),
          exitCode: 124,
          logs: "",
          name,
          pid: "",
          startedAt: "",
          status: "killed",
          stderr: `Command timed out after ${timeoutMs}ms`,
          stdout: "",
          workingDir: ""
        };
      }
      throw error;
    }
  }

  private async shellResultWithLogs(
    result: BlaxelWaitResult,
    fallback: BlaxelProcessResult
  ): Promise<ShellResult> {
    const resultWithFallback = {
      ...fallback,
      ...result
    };
    const stdout =
      typeof resultWithFallback.stdout === "string"
        ? resultWithFallback.stdout
        : await this.sandbox.process.logs(resultWithFallback.name, "stdout").catch(() => "");
    const stderr =
      typeof resultWithFallback.stderr === "string"
        ? resultWithFallback.stderr
        : await this.sandbox.process.logs(resultWithFallback.name, "stderr").catch(() => "");

    return shellResult({
      ...resultWithFallback,
      stdout,
      stderr
    });
  }

  private attachKillOnAbort(name: string, signal: AbortSignal | undefined): () => void {
    if (!signal) {
      return () => undefined;
    }

    const onAbort = () => {
      void this.sandbox.process.kill(name).catch(() => undefined);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  private async mkdirRecursive(directoryPath: string): Promise<void> {
    const parts = directoryPath.split("/").filter(Boolean);
    let currentPath = "/";

    for (const part of parts) {
      currentPath = path.join(currentPath, part);
      try {
        await this.sandbox.fs.mkdir(currentPath);
      } catch (error) {
        if (await this.isExistingDirectory(currentPath, error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async isExistingDirectory(
    directoryPath: string,
    mkdirError: unknown
  ): Promise<boolean> {
    if (isNotFoundError(mkdirError)) {
      return false;
    }

    try {
      const stat = await this.stat(directoryPath);
      return stat.isDirectory;
    } catch {
      return false;
    }
  }

  private async isDirectory(directoryPath: string): Promise<boolean> {
    try {
      await this.sandbox.fs.ls(directoryPath);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }
}

function normalizeSandboxPath(filePath: string): string {
  return path.resolve("/", filePath);
}

function fileStat(file: BlaxelFile): FileStat {
  const stat: FileStat = {
    isDirectory: false,
    isFile: true,
    size: file.size
  };
  const mtime = parseDate(file.lastModified);
  if (mtime) {
    stat.mtime = mtime;
  }
  return stat;
}

function directoryStat(_directory: BlaxelSubdirectory): FileStat {
  return {
    isDirectory: true,
    isFile: false
  };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function shellResult(result: Partial<BlaxelProcessResult | BlaxelWaitResult>): ShellResult {
  return {
    exitCode:
      typeof result.exitCode === "number"
        ? result.exitCode
        : result.status === "completed"
          ? 0
          : 1,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : ""
  };
}

function timeoutSeconds(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (timeoutMs <= 0) {
    return 0;
  }
  return Math.ceil(timeoutMs / 1000);
}

function processName(): string {
  return `flue-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw abortError();
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isWaitTimeoutError(error: unknown): boolean {
  return error instanceof Error && /did not finish in time|timed out/i.test(error.message);
}

function isProcessTimeoutError(error: unknown): boolean {
  const candidate = error as {
    error?: unknown;
    message?: string;
  };

  if (typeof candidate.message === "string" && /process timed out|timed out/i.test(candidate.message)) {
    return true;
  }

  if (
    candidate.error &&
    typeof candidate.error === "object" &&
    "error" in candidate.error &&
    typeof candidate.error.error === "string"
  ) {
    return /process timed out|timed out/i.test(candidate.error.error);
  }

  return false;
}

function timeoutResult(timeoutMs: number | undefined): ShellResult {
  return {
    exitCode: 124,
    stderr: `Command timed out after ${timeoutMs}ms`,
    stdout: ""
  };
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof BlaxelPathNotFoundError) {
    return true;
  }

  const candidate = error as {
    code?: unknown;
    response?: { status?: number };
    status?: number;
    message?: string;
  };

  if (candidate.code === "ENOENT" || candidate.response?.status === 404 || candidate.status === 404) {
    return true;
  }

  if (!candidate.message) {
    return false;
  }

  try {
    const parsed = JSON.parse(candidate.message) as { status?: number; error?: string };
    if (parsed.status === 404 || /not found/i.test(parsed.error ?? "")) {
      return true;
    }
  } catch {
    // Fall through to text matching.
  }

  return /not found|no such file|directory not found|file not found/i.test(candidate.message);
}

class BlaxelPathNotFoundError extends Error {
  readonly code = "ENOENT";

  constructor(filePath: string) {
    super(`Path not found: ${filePath}`);
  }
}
```

## Required dependencies

Install the Blaxel SDK if it is not already present:

```sh
npm install @blaxel/core@^0.2.93
```

The project must also have `@flue/runtime` installed, which every Flue project
already uses.

## Authentication

The adapter expects normal Blaxel authentication to work wherever the Flue app
runs. For local development, set `BL_WORKSPACE` and either `BL_API_KEY` or a
working Blaxel CLI login. For deployed environments, provide the equivalent
workspace and token through that runtime's secret mechanism.

## Wiring it into an agent

Create and configure the Blaxel sandbox in application code, then pass the
adapter factory to the agent:

```ts
import { SandboxInstance } from "@blaxel/core";
import { createAgent, type FlueContext } from "@flue/runtime";
import { blaxel } from "../sandboxes/blaxel";

export async function run({ init }: FlueContext) {
  const sandbox = await SandboxInstance.createIfNotExists({
    image: "blaxel/base-image:latest",
    memory: 4096,
    name: "flue-blaxel",
    region: process.env.BL_REGION ?? "us-pdx-1"
  });

  await sandbox.wait({ interval: 3000, maxWait: 180_000 });

  const agent = createAgent(() => ({
    sandbox: blaxel(sandbox),
    model: "anthropic/claude-sonnet-4-6"
  }));

  const harness = await init(agent);
  const session = await harness.session();
  return await session.shell("uname -a");
}
```

Use the Blaxel SDK for image, region, memory, labels, volumes, environment,
retention, and deletion policy. The adapter defaults to `/tmp`, which exists in
Blaxel's base image and is safe for scratch work. For a narrower project
workspace, create that directory in the image or at startup, then pass
`blaxel(sandbox, { cwd: "/path" })`; Flue resolves agent `cwd` values relative
to that adapter base during `init()`.

## Verify

Run the project typechecker, then initialize a Flue agent with `model: false`
and this sandbox adapter so `harness.session().shell(...)` can run without
model credentials. Verify at least these behaviors against a disposable Blaxel
sandbox:

- `session.fs.writeFile(...)`, `readFile(...)`, `readFileBuffer(...)`,
  `stat(...)`, `readdir(...)`, `exists(...)`, and `rm(...)`
- `session.shell(...)` with stdout, stderr, non-zero exit codes, `cwd`, `env`,
  pipes, redirection, command timeouts, and aborts
- `harness.fs` and `harness.shell(...)`, because users may call either surface
- cleanup of the scratch directory and, when disposable, deletion of the
  sandbox itself

## Upgrade Guide

### Version 1 — 2026-06-17

Initial version.
