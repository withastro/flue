# Project Layout

Use this when deciding where Flue discovers authored source and what gets generated.

## Discovery Order

Flue chooses one source directory relative to the project root:

1. `<root>/.flue/`
2. `<root>/src/`
3. `<root>/`

The first matching directory wins. Flue does not merge layouts. If `.flue/` exists, bare `src/`, `agents/`, `workflows/`, and `channels/` outside `.flue/` are ignored for discovery.

## Discovered Entrypoints

| Path | Rule |
| --- | --- |
| `app.ts` | Optional Hono app that composes application routes and mounts `flue()`. |
| `cloudflare.ts` | Optional Cloudflare-only Worker extensions, named exports, and non-HTTP handlers. |
| `agents/` | Immediate files define addressable agents. Filename becomes agent name. Nested files are support modules only. |
| `workflows/` | Immediate files define workflows. Filename becomes workflow name. Nested files are support modules only. |
| `channels/` | Immediate files export one named `channel`. Filename becomes immutable route namespace under `/channels/<name>/...`. |
| `db.ts` | Node-only persistence adapter. Rejected on Cloudflare. |

Prefer lower-kebab-case filenames for discovered agents, workflows, and channels.

## Generated Output

- `dist/` is generated output by default and is not authored source.
- Change output with `output` in `flue.config.ts`.
- Change project root with `root` in `flue.config.ts` or CLI `--root`.
- Build target is `target: 'node' | 'cloudflare'` or CLI `--target`.

## Common Mistakes

| Symptom | Check |
| --- | --- |
| Agent or workflow is not discovered | Is it nested? Is another source root winning? Does `.flue/` exist? |
| Channel route is not at expected path | Channel filename defines namespace; package defines non-empty suffix; `app.ts` prefix applies to all Flue routes. |
| Cloudflare build rejects `db.ts` | Cloudflare uses generated Durable Object SQLite; remove `db.ts`. |

