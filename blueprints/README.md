# Flue Blueprints

This directory contains the source-of-truth Markdown implementation guides returned by `flue add` and `flue update`. Both commands return the same complete guide for the selected blueprint; the guide must work for adding a new integration and updating an existing one without conditional show/hide instructions. Blueprints are served at `https://flueframework.com/cli/blueprints/<slug>.md`.

A blueprint is a Markdown guide for an AI coding agent, not an npm package or runtime abstraction. The CLI fetches and prints the guide; the coding agent edits the user's project.

## Supported kinds

| Kind       | Result                                                            |
| ---------- | ----------------------------------------------------------------- |
| `sandbox`  | A sandbox adapter for a remote execution provider.                |
| `channel`  | Verified provider ingress, a client, and application-owned tools. |
| `database` | A database adapter implementing Flue's `PersistenceAdapter`.      |
| `tooling`  | A developer-tool integration such as observability or evaluation. |

Do not introduce a new kind without first discussing the required CLI, runtime, and maintenance changes with the Flue team. New blueprints within an existing kind are welcome.

## File naming

Named blueprints use `<kind>--<name>.md`. Generic kind guides use `<kind>.md` and set `"root": true`.

```text
blueprints/
  sandbox.md
  sandbox--daytona.md
```

The double dash leaves provider names containing a single dash unambiguous. The index generator derives these routes:

- `<kind>--<name>.md` becomes `<name>`.
- `<kind>.md` is available by kind for `flue add <kind> <url>`.

The generator is `packages/cli/scripts/generate-blueprint-index.ts`. Duplicate slugs are rejected.

## Frontmatter

Every blueprint starts with JSON frontmatter fenced by `---`. It is JSON, not YAML.

Generic kind guide:

```json
{ "kind": "sandbox", "version": 1, "root": true }
```

Named blueprint:

```json
{ "kind": "sandbox", "version": 1, "website": "https://daytona.io" }
```

| Field     | Type     | Required for     | Description                                      |
| --------- | -------- | ---------------- | ------------------------------------------------ |
| `kind`    | string   | every blueprint  | `sandbox`, `channel`, `database`, or `tooling`   |
| `version` | integer  | every blueprint  | Positive, monotonically increasing guide version |
| `website` | string   | named blueprints | Provider homepage shown by `flue add`            |
| `aliases` | string[] | optional         | Additional names accepted by `flue add`          |
| `root`    | boolean  | generic guides   | Must be `true`                                   |

The website strips frontmatter before returning the guide.

Aliases are for established package or product names that users are likely to enter, such as `@vercel/sandbox`. Use them sparingly. They must not collide with another slug or alias; matching is case-insensitive.

## Versions and generated-file markers

`version` identifies the complete blueprint contract. Start a new blueprint at `1` and increment it by exactly one whenever the guide changes generated files, dependencies, configuration, wiring, setup, verification, or upgrade instructions in a way an existing consumer should apply. Editorial changes that do not alter implementation behavior do not require a bump. Never decrement, reuse, or skip a version. A version bump must update the frontmatter version, every primary-file marker example in the guide, and the cumulative Upgrade Guide with the new version entry.

A generated-file marker identifies the primary integration file managed by the blueprint. It is the first generated line in that file, before imports or other comments:

```ts
// flue-blueprint: sandbox/daytona@1
```

Named guides use `// flue-blueprint: <kind>/<slug>@<version>` when they have a primary generated file. Put it only in that file: typically `channels/<provider>.ts` for a channel, `sandboxes/<provider>.ts` for a sandbox adapter, or `db.ts` for a database adapter. Do not mark agent wiring, clients, deployment modules, prerequisite or auxiliary files, or other complete TypeScript snippets. A database guide may mark each mutually exclusive complete `db.ts` alternative because each alternative is the primary file. Some named guides, such as `sandbox--cloudflare.md`, have no primary marked file; do not invent a marker in an auxiliary or deployment file.

Every named guide must tell the coding agent how to update an implementation with no usable marker. The agent inspects and compares the existing implementation against the complete current blueprint, applies every relevant change while preserving customizations, and then adds or updates the marker if the blueprint has a primary marked file. When there is no primary marked file, comparison is the durable update behavior. Put this instruction immediately before or within `## Upgrade Guide` so it is included in the served blueprint.

Generic channel guides use `// flue-blueprint: channel/<provider>@<version>` in the resulting `channels/<provider>.ts`, replacing `<provider>` when the provider is selected. Generic sandbox and database guides that do not contain a complete implementation carry no marker in the guide, but must instruct the coding agent to put `// flue-blueprint: sandbox/<provider>@<version>` in the resulting `sandboxes/<provider>.ts` or `// flue-blueprint: database/<provider>@<version>` in the resulting `db.ts`.

Every blueprint body ends with exactly one cumulative `## Upgrade Guide`, and it must be the final H2 section. Add entries in ascending, contiguous order (`Version 1`, `Version 2`, `Version 3`) using `### Version N — YYYY-MM-DD` headings with ISO dates, retain every prior entry, and keep the final version equal to the frontmatter version.

Version 1 contains exactly `Initial version.` and no diff because no prior generated implementation exists. Every entry after Version 1 must include a fenced `diff` block with a complete unified diff, including `--- ` and `+++ ` file headers, showing the expected change from the immediately previous blueprint version. Prose states what changed and any important context; the diff is the normative mechanical upgrade. The diff must be sufficient for an agent starting from the previous version to apply that version's complete expected change without reconstructing it from prose or later entries. The index generator validates this body contract along with frontmatter; `version` must be a positive safe integer.

## Body conventions

The body is an implementation guide consumed by an AI coding agent. Follow the conventions for its kind.

### Sandbox adapter blueprints

A sandbox blueprint should:

1. Explain that it installs a sandbox adapter and that the application owns the provider resource lifecycle.
2. Select the first existing source root from `<root>/.flue/`, `<root>/src/`, and `<root>/`.
3. Write the implementation to `<source-root>/sandboxes/<name>.ts`.
4. Include complete TypeScript ready to write, required dependencies, authentication, agent wiring, and verification steps.
5. Use runtime API names such as `SandboxFactory` exactly as exported.

Generic `sandbox.md` points to the sandbox adapter contract and a known implementation blueprint instead of embedding one provider implementation.

### Channel blueprints

A channel blueprint should:

1. Inspect the target, source root, app entrypoint, agents, environment types, and secret conventions.
2. Install a first-party ingress package when available and an established outbound SDK or narrow Fetch client.
3. Create `channels/<provider>.ts` with named `channel` and `client` exports.
4. Mount the channel in `app.ts` (`app.route('/channels/<provider>', channel.route())`) and derive every provider webhook URL from the mount path.
5. Use constructor-owned verified callbacks and exact default-path guidance.
6. Dispatch normalized provider input and stable delivery identity.
7. Define only requested tools, with trusted destinations outside model arguments.
8. Verify signed payloads against the project's actual build target.

Do not imply a common provider-client API or install generic tool collections.

### Database adapter blueprints

Database blueprints produce a source-root `db.ts` that default-exports a `PersistenceAdapter`, not a file under `sandboxes/`.

Named blueprints with first-party packages install `@flue/<backend>` and create a small `db.ts`. The generic guide points to the `PersistenceAdapter` contract and the PostgreSQL blueprint as an implementation example.

Database adapters are for the Node target; Cloudflare uses Durable Object SQLite and rejects `db.ts`. Read connection strings from the environment and do not store application business data in the adapter.

### Tooling blueprints

Tooling is a catchall for developer integrations such as observability, evaluation, debugging, security, and operational services that do not implement the channel, database, or sandbox contracts.

A tooling blueprint should inspect the configured target and runtime boundaries before selecting packages or extension points. Use target-specific SDKs, public Flue APIs such as `observe(...)`, and module-local Cloudflare extensions when generated Durable Objects require wrapping. Tooling may touch several existing application files; use a primary-file marker only when the integration owns one durable source file. Otherwise, comparison against the complete blueprint is the update contract.

## Adding a blueprint

1. Create `blueprints/<kind>--<name>.md` with JSON frontmatter and an implementation guide.
2. Run the CLI prebuild to regenerate the blueprint index and validate frontmatter.
3. Run the website locally and check `http://localhost:4321/cli/blueprints/<name>.md`.
4. Pipe `flue add <kind> <name>` and `flue update <kind> <name>` to a coding agent in a sample project. Both return the same complete guide; verify new and existing implementations converge on its current version.
