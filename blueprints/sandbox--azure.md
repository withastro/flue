---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://sandboxes.azure.com",
  "aliases": ["@azure/containerapps-sandbox"]
}
---

# Add a Flue Sandbox Adapter: Azure Container Apps Sandboxes

You are an AI coding agent installing the Azure Sandboxes adapter in a
Node-hosted Flue project. Follow this complete guide for both installation
and updates.

## What this adapter does

Wraps an application-owned `SandboxGroupClient` and existing sandbox ID into
Flue's `SandboxFactory`. The application owns Azure authentication, sandbox
group provisioning, creation, resume, retention, and deletion. This adapter
does not provision Azure resources or choose a lifecycle policy.

Use a running Linux sandbox with `sh`, `env`, `base64`, `mkdir`, and GNU
`timeout` (coreutils). The Azure Ubuntu image is the starting point; verify
these commands in your chosen image. Cloudflare Workers compatibility is
not established by this guide.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then
`<root>/src/`, then `<root>/`. Write the following complete implementation
to `<source-root>/sandboxes/azure.ts`, creating parent directories as needed.

## File contents

```ts
// flue-blueprint: sandbox/azure@1
import {
	sandboxFromDriver,
	SandboxDiedError,
	SandboxOperationUnsupportedError,
} from '@flue/runtime';
import type { FileStat, SandboxDriver, SandboxFactory, ShellResult } from '@flue/runtime';
import type { SandboxGroupClient } from '@azure/containerapps-sandbox';

function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
	);
}

class AzureSandboxDriver implements SandboxDriver {
	private client: SandboxGroupClient;
	private sandboxId: string;

	constructor(client: SandboxGroupClient, sandboxId: string) {
		this.client = client;
		this.sandboxId = sandboxId;
	}

	private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			// A file 404 alone cannot distinguish a missing path from a missing sandbox.
			// Probe after failure, preserving the original error if status is unavailable.
			try {
				const sandbox = await this.client.sandboxes.get(this.sandboxId, {
					abortSignal: AbortSignal.timeout(5_000),
				});
				if (
					sandbox.state !== undefined &&
					['Stopped', 'Suspended', 'Idle', 'Deleting', 'Disabled', 'Failed'].includes(sandbox.state)
				) {
					throw new SandboxDiedError({ operation, reason: 'stopped' });
				}
				if (isNotFound(error) && sandbox.state !== 'Running') {
					throw new Error(
						'Azure sandbox is not confirmed running; cannot determine whether the path exists.',
						{ cause: error },
					);
				}
			} catch (probeError) {
				if (probeError instanceof SandboxDiedError) throw probeError;
				if (isNotFound(probeError)) {
					throw new SandboxDiedError({ operation, reason: 'stopped' });
				}
				// Do not turn a file 404 into "absent" without a successful state probe.
				if (isNotFound(error)) throw probeError;
			}
			throw error;
		}
	}

	async readFile(path: string): Promise<string> {
		return new TextDecoder().decode(await this.readFileBuffer(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		// SDK beta.1 files.read() decodes HTTP bytes as text, corrupting binary data.
		// Base64 travels losslessly through the shell API's JSON response.
		const result = await this.checkedExec(`base64 < ${quote(path)}`);
		return new Uint8Array(Buffer.from(result.stdout, 'base64'));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.call('writeFile', () => this.client.files.write(this.sandboxId, path, content));
	}

	async stat(path: string): Promise<FileStat> {
		const info = await this.call('stat', () => this.client.files.stat(this.sandboxId, path));
		return {
			isFile: !info.isDirectory,
			isDirectory: info.isDirectory,
			size: info.size,
			mtime: info.modifiedAt === undefined ? undefined : new Date(info.modifiedAt),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const listing = await this.call('readdir', () => this.client.files.list(this.sandboxId, path));
		return listing.entries.map((entry) => entry.name);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			await this.checkedExec(`mkdir -p -- ${quote(path)}`);
		} else {
			await this.call('mkdir', () => this.client.files.mkdir(this.sandboxId, path));
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.force) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Azure Sandboxes',
				options: ['force'],
			});
		}
		await this.call('rm', () =>
			this.client.files.delete(this.sandboxId, path, {
				recursive: options?.recursive,
			}),
		);
	}

	private async checkedExec(command: string): Promise<ShellResult> {
		const result = await this.exec(command);
		if (result.exitCode !== 0) {
			throw new Error(`Azure sandbox file operation failed (${result.exitCode}): ${result.stderr}`);
		}
		return result;
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<ShellResult> {
		const environment = Object.entries(options?.env ?? {}).map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`Invalid environment variable name: ${key}`);
			}
			return quote(`${key}=${value}`);
		});
		let wrapped = `env -- ${environment.join(' ')} sh -c ${quote(command)}`;
		if (options?.timeoutMs !== undefined) {
			if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
				throw new RangeError('timeoutMs must be a finite non-negative number');
			}
			if (options.timeoutMs === 0) {
				return { stdout: '', stderr: 'Command timed out before execution.', exitCode: 124 };
			}
			const seconds = Math.ceil(options.timeoutMs) / 1000;
			wrapped = `timeout --kill-after=1s ${seconds}s ${wrapped}`;
		}
		// The SDK has no process-cancel API. Let sandboxFromDriver own the abort
		// race and consume late settlement; aborting HTTP would not kill the process.
		return this.call('exec', () =>
			this.client.sandboxes.exec(this.sandboxId, {
				command: wrapped,
				workingDirectory: options?.cwd,
			}),
		);
	}
}

export function azure(
	client: SandboxGroupClient,
	sandboxId: string,
	options: { cwd: string },
): SandboxFactory {
	return {
		async createSandbox() {
			return sandboxFromDriver(new AzureSandboxDriver(client, sandboxId), options.cwd);
		},
	};
}
```

## Required dependencies

Install the SDK version this implementation targets and Azure Identity in
the consuming application, using its package manager:

```bash
npm install @azure/containerapps-sandbox@1.0.0-beta.1 @azure/identity
```

Use the application's existing Node.js types for `Buffer`. Do not add Azure
dependencies to `@flue/runtime`.

## Authentication and setup

Follow the [Azure TypeScript quickstart](https://sandboxes.azure.com/docs/sandboxes/quickstart/setup-typescript-sdk)
to provision a sandbox group and grant the application's identity data-plane
access. Its example uses the `Container Apps SandboxGroup Data Owner` role
scoped to the sandbox group. Provisioning and role assignments are one-time
administrative setup, not agent initialization work.

For local development, `az login` supplies an identity to
`DefaultAzureCredential`. In Azure, configure a managed identity with access
to the sandbox group. Do not invent credentials or embed tokens in code.
Use the project's existing environment/secret conventions.

Configure `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`,
`AZURE_SANDBOX_GROUP`, `AZURE_REGION`, and `AZURE_SANDBOX_ID`. The ID must
identify a sandbox that the application has created and resumed. Set its
idle policy deliberately so it does not suspend during active agent work.

`flue run` loads `.env` by default; `--env <file>` selects an alternate file.
`vite dev` and built servers read the shell environment (`process.env`).

## Wiring it into an agent

This example attaches one existing sandbox. Use it for one trusted workspace;
do not point unrelated tenants at the same sandbox. The application must
create `/workspace` before using it as the working directory.

```ts
'use agent';
import { SandboxGroupClient, endpointForRegion } from '@azure/containerapps-sandbox';
import { DefaultAzureCredential } from '@azure/identity';
import { useModel, useSandbox } from '@flue/runtime';
import { azure } from '../sandboxes/azure';

export function Assistant() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox({
		async createSandbox(options) {
			const client = new SandboxGroupClient(
				new DefaultAzureCredential(),
				endpointForRegion(process.env.AZURE_REGION!),
				process.env.AZURE_SUBSCRIPTION_ID!,
				process.env.AZURE_RESOURCE_GROUP!,
				process.env.AZURE_SANDBOX_GROUP!,
			);
			return azure(client, process.env.AZURE_SANDBOX_ID!, {
				cwd: '/workspace',
			}).createSandbox(options);
		},
	});
	return 'You are a helpful assistant with an Azure Linux sandbox.';
}
```

For per-agent workspaces, persist the mapping from `createSandbox({ id })`'s
agent instance ID to an Azure sandbox ID in application storage. Reconnect
and resume that resource on subsequent initialization, and coordinate
concurrent creation for the same ID. Do not create a fresh sandbox on each
render or each initialization. Sandbox filesystem state is separate from
Flue conversation persistence.

The application deletes or suspends its sandbox when appropriate; Flue's
factory interface has no cleanup hook. Mount `createAgentRouter(Assistant)`
in `app.ts` only when the agent needs an HTTP endpoint.

## Behavior and limitations

- Reads use base64 over command execution to preserve binary data with SDK
  beta.1. They buffer the entire file and are subject to the service's command
  output limits; this is not a streaming or large-artifact transfer API.
- Writes use the SDK's default parent-directory creation. Metadata preserves
  available size and modification time; the SDK does not expose a symlink flag.
- Recursive directory creation uses `mkdir -p`. Removal forwards `recursive`
  and rejects `force` before modifying anything.
- Command environment values are shell-quoted. `timeoutMs` uses GNU `timeout`
  inside the sandbox, rounding fractional milliseconds up. Expiry normally
  returns 124; a process that ignores TERM is killed after a one-second grace
  period and may return 137. Commands without a deadline remain unbounded.
- Caller cancellation rejects promptly through `sandboxFromDriver`, but the
  remote command may continue. No second abort race is implemented here.
- Failed operations probe sandbox state. Confirmed missing, stopped, suspended, idle, deleting, disabled,
  or failed sandboxes raise `SandboxDiedError`. If a provider request never
  settles after sandbox loss, there is no background liveness polling: an
  exec caller must abort to release its wait. A failed state probe preserves
  an error rather than reporting a path as absent.

## Verify

1. Typecheck the generated adapter and agent in the consuming project.
2. Verify `sh`, `env`, `base64`, `mkdir`, and GNU `timeout` exist in the sandbox,
   and create the configured working directory.
3. Run `flue run <agent-module> --message "Write a file, read it back, and run pwd"`.
4. Exercise binary reads/writes, nested paths, directory listing, recursive
   creation/removal, and a command with separate stdout/stderr and exit code 7.
5. Check deadlines with `sleep`, including a TERM-ignoring process, and check
   pre-aborted and mid-flight-aborted commands. Confirm remote cleanup separately.
6. Verify missing files return false from `exists`, authorization failures
   propagate, and deleted/stopped sandboxes are classified as infrastructure failures.
7. Reinitialize against the same ID and confirm files remain. Explicitly clean
   up the application-owned sandbox after a disposable smoke test.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-09-13

Initial version.
