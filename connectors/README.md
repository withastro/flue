# Flue Connectors

This directory holds the source-of-truth markdown files for all Flue
connectors served at `https://flueframework.com/cli/connectors/<slug>.md`
and pulled into user projects via `flue add <name>`.

A connector is **a markdown file with installation instructions for an AI
coding agent**, not an npm package. The CLI is a fetch-and-print pipe; the
agent does the file-writing.

## Supported categories

Flue currently supports **one** connector category:

| Category  | Status     | Notes                                                  |
| --------- | ---------- | ------------------------------------------------------ |
| `sandbox` | Supported  | For remote sandbox providers (Daytona, E2B, Modal, etc.). |

> **Please don't open PRs introducing new categories.** Adding a category
> requires CLI/runtime changes and a long-term maintenance commitment from
> the Flue team. New _connectors_ inside an existing supported category are
> welcome — see "Adding a new connector" below.
>
> If you have a use case you think warrants a new category, open a
> discussion or issue first.

## File naming

Connectors use a `<category>--<name>.md` filename convention. Category roots
(generic instructions for a category) use the bare `<category>.md` filename.

```
connectors/
  sandbox.md                 # Generic instructions for the "sandbox" category.
                             # Addressable as: flue add <url> --category sandbox
                             # The CLI substitutes the user-provided URL into
                             # the markdown's {{URL}} placeholder before piping.
  sandbox--daytona.md        # The Daytona sandbox connector.
                             # Addressable as: flue add daytona
```

The double-dash separator is used so that providers whose names contain
single dashes (e.g. `cloud-run`, `fly-io`) don't conflict with the
category boundary.

## Slug derivation

The CLI's prebuild script (`packages/cli/scripts/generate-connector-index.ts`)
derives slugs:

- `<category>--<name>.md` → slug `<name>`
- `<category>.md` (with `"root": true`) → not addressable as a connector
  slug; only via `flue add <url> --category <category>`

If two files would resolve to the same slug, the prebuild script errors out.

## Frontmatter (JSON, not YAML)

Every connector markdown file begins with a JSON frontmatter block fenced by
`---` lines. The CLI parses it with `JSON.parse()` — no YAML dependency.

For category roots:

```markdown
---
{
  "category": "sandbox",
  "root": true
}
---
```

For named connectors:

```markdown
---
{
  "category": "sandbox",
  "website": "https://daytona.io"
}
---
```

Required fields:

| Field      | Type    | Required when           | Description                                   |
| ---------- | ------- | ----------------------- | --------------------------------------------- |
| `category` | string  | always                  | Connector category. Must be one of the supported categories listed above. |
| `website`  | string  | named connectors only   | Provider's homepage. Shown in `flue add` listing |
| `root`     | boolean | category roots only     | Must be `true`. Marks file as the category root |

The website strips frontmatter when serving the markdown — agents and humans
see clean content.

## Body conventions

The body is the prompt an AI coding agent will read and act on. The
existing connectors (`sandbox--daytona.md` and `sandbox--vercel.md`) are
the template — match their structure as closely as possible, and only
diverge where the specifics of the provider you're connecting genuinely
require it.

For reference, the shape they share:

1. A single sentence framing what the connector is and that the reader is
   an AI agent installing it.
2. **What this connector does** — one paragraph, "wraps an
   already-initialized X into Flue's `SandboxFactory`; user owns the
   provider lifecycle".
3. **Where to write the file** — be explicit about the `.flue/` vs root
   layout choice and tell the agent to ask if unsure.
4. **The full TypeScript file content** in a code block, ready to write
   verbatim. Don't include placeholders the agent has to fill in.
5. **Required dependencies** — what the agent should `npm install`.
6. **Authentication** — how the provider authenticates (env var, OIDC,
   OAuth, certs, etc.), where credentials should live, and a note never
   to invent values. The shape of this section will vary the most between
   providers; let the provider's actual auth model drive it.
7. **Wiring it into an agent** — a usage snippet for one of the user's
   agents.
8. **Verify** — typecheck + manual next-steps for the user, ending with
   `flue dev` / `flue run <agent>`.

For category-root files (e.g. `sandbox.md`), instead of a verbatim TS file,
point the agent at the spec doc on raw GitHub plus a known-good reference
connector (e.g. `daytona`).

## Adding a new connector

1. Create `connectors/<category>--<name>.md` with the JSON frontmatter and
   instructions for the agent.
2. Run the CLI prebuild (`pnpm --filter @flue/cli build`) to regenerate
   `packages/cli/bin/_connectors.generated.ts` and validate frontmatter.
3. Confirm the file is served correctly via the local website
   (`pnpm --filter @flue/www dev`) at
   `http://localhost:4321/cli/connectors/<name>.md`.
4. Try it end-to-end: pipe `flue add <name>` to a coding agent in a sample
   project and confirm the agent successfully installs the connector.
