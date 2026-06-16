# Sandbox Model

Use this when choosing or explaining agent workspace access.

## Sandbox Choices

| Sandbox | Use when |
| --- | --- |
| Virtual sandbox | The application can provide needed files and only lightweight workspace work is required. |
| Node `local()` | Trusted Node.js agent should operate directly on host files and shell. |
| Remote sandbox | Work needs isolation, tenant-specific workspace, Linux tooling, provider-managed lifecycle, or durable files. |
| Cloudflare Sandbox | Cloudflare-deployed agent needs container-backed Linux shell, git, packages, or native commands. |
| Cloudflare Shell / Codemode | Cloudflare agent needs durable structured code operations, not arbitrary Linux shell. |

## Virtual Sandbox

- Default when no `sandbox` is configured.
- In-memory workspace powered by `just-bash`.
- Starts without application files or host filesystem.
- Files do not persist beyond in-memory lifetime.
- Suitable for staged documents and lightweight file/command work.
- Not a network isolation boundary.

## Node `local()`

- Direct host filesystem and shell access.
- Node target only.
- Good for trusted dev tools, disposable CI, and self-hosted automation.
- Not isolation from model-directed commands.
- Expose environment variables narrowly through `local({ env })`.

## Remote Sandbox

Application owns:

- workspace selection per agent instance or workflow;
- credentials and network access;
- reuse policy;
- deletion and expiry;
- mapping between session history and workspace lifecycle.

## Persistence Separation

| Question | Controlled by |
| --- | --- |
| Does conversation history continue later? | Session persistence via `db.ts`, target default, or Durable Object SQLite. |
| Do files and installed packages remain? | Sandbox/workspace lifecycle. |
| What can commands or tools access? | Sandbox environment, tools, and application authorization. |

A persisted session does not make the virtual sandbox durable. A durable remote workspace does not preserve conversation history by itself.

