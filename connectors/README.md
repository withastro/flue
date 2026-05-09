# Flue Connectors

This directory holds the source-of-truth markdown files for all Flue
connectors served at `https://flueframework.com/cli/connectors/<slug>.md`
and pulled into user projects via `flue add <name>`.

A connector is **a markdown file with installation instructions for an AI
coding agent**, not an npm package. The CLI is a fetch-and-print pipe; the
agent does the file-writing.

## Supported categories

Flue supports the following connector categories:

| Category  | Status     | Notes                                                                       |
| --------- | ---------- | --------------------------------------------------------------------------- |
| `sandbox` | Supported  | For remote sandbox providers (Daytona, E2B, Modal, etc.).                   |
| `persist` | Supported  | For session-store backends (Postgres, D1, etc.) — durable agent sessions.   |

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

Or, for a persist connector:

```markdown
---
{
  "category": "persist",
  "website": "https://www.postgresql.org"
}
---
```

Fields:

| Field      | Type     | Required when           | Description                                   |
| ---------- | -------- | ----------------------- | --------------------------------------------- |
| `category` | string   | always                  | Connector category. Must be one of the supported categories listed above. |
| `website`  | string   | named connectors only   | Provider's homepage. Shown in `flue add` listing |
| `aliases`  | string[] | optional                | Additional names users can pass to `flue add`. See "Aliases" below |
| `root`     | boolean  | category roots only     | Must be `true`. Marks file as the category root |

The website strips frontmatter when serving the markdown — agents and humans
see clean content.

### Aliases

`aliases` lets a connector be addressable by names beyond its canonical slug.
For example, `sandbox--vercel.md` declares `"aliases": ["@vercel/sandbox"]`,
so `flue add @vercel/sandbox` and `flue add vercel` both resolve to the same
connector. The canonical slug is still what the listing UI advertises and
what the registry URL is keyed on; aliases are purely a convenience for
users who'd otherwise type a more specific name.

**Use aliases sparingly.** They're reserved for cases where the canonical
brand name is genuinely ambiguous because the company has multiple products
(e.g. Vercel does hosting, sandboxes, and databases — `vercel` alone doesn't
say which one). Don't add aliases for synonyms, marketing variants, or
spelling preferences.

The prebuild script enforces uniqueness: an alias can't collide with another
connector's slug or another connector's alias. CLI lookups are
case-insensitive against both slugs and aliases, so you don't need to add
casing variants.

## Body conventions

The body is the prompt an AI coding agent will read and act on. The
existing connectors in the same category are the template — match their
structure as closely as possible, and only diverge where the specifics of
what you're connecting genuinely require it.

For reference, the shape they share:

1. A single sentence framing what the connector is and that the reader is
   an AI agent installing it.
2. **What this connector does** — one paragraph. For `sandbox`, "wraps an
   already-initialized X into Flue's `SandboxFactory`; user owns the
   provider lifecycle". For `persist`, "wraps a configured X client into
   Flue's `SessionStore`; user owns the client/binding lifecycle".
3. **Where to write the file** — be explicit about the source-layout choice
   (`<root>/.flue/` vs. `<root>/`) and tell the agent to ask if unsure.
   `sandbox` connectors land in `connectors/<name>.ts`; `persist` connectors
   land in `persist/<name>.ts`.
4. **The full TypeScript file content** in a code block, ready to write
   verbatim. Don't include placeholders the agent has to fill in.
5. **Schema or required dependencies** — `persist` connectors include the
   `CREATE TABLE` (or equivalent) for the backend's session table.
   `sandbox` connectors list what the agent should `npm install`.
6. **Authentication / credentials.** How the backend or provider
   authenticates (env var, OIDC, OAuth, wrangler binding, certs, etc.),
   where credentials should live, and a note never to invent values. The
   shape of this section will vary the most between connectors; let the
   actual auth/binding model drive it.
7. **Wiring it into an agent** — a usage snippet for one of the user's
   agents. `sandbox` connectors pass the factory to `init({ sandbox })`;
   `persist` connectors pass the store to `init({ persist })`.
8. **Verify** — typecheck + manual next-steps for the user, ending with
   `flue dev` / `flue run <agent>`.

For category-root files (e.g. `sandbox.md`, `persist.md`), instead of a
verbatim TS file, point the agent at the spec/contract plus a known-good
reference connector (e.g. `daytona` for sandbox, `postgres` for persist).

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
