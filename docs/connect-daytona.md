# Connect a Daytona Sandbox

This guide takes a working Flue agent and connects it to a [Daytona](https://www.daytona.io/) remote sandbox so each session gets a fully isolated Linux environment — git, Node.js, Python, system packages, the lot.

## Prerequisites

You should already have a Flue project that builds and runs. If you don't yet, start with one of the deploy guides — whichever target you're using or prefer:

- [Deploy on Node.js](./deploy-node.md)
- [Deploy on GitHub Actions](./deploy-github-actions.md)
- [Deploy on GitLab CI/CD](./deploy-gitlab-ci.md)
- [Deploy on Cloudflare](./deploy-cloudflare.md)

Each leaves you with a working Hello World agent, a verified run loop, and no remote sandbox wired up yet. That's the starting point.

## Sign up for Daytona

Sign up at [daytona.io](https://www.daytona.io/) and grab an API key from your dashboard. Then set `DAYTONA_API_KEY` in the same place you already set your model provider key (your `.env` file, your CI secrets, or your Cloudflare secrets bundle — whichever the prerequisite guide had you set up).

The SDK also reads optional `DAYTONA_API_URL` and `DAYTONA_TARGET` if you need them — see [Daytona's environment configuration docs](https://www.daytona.io/docs/en/configuration/).

## Install the connector

Install the Daytona connector with `flue add`. Always pass `--print` — it's the safe default whether you're a human pasting the output into your coding agent of choice, or an agent running this command yourself:

```bash
# Print the install instructions and let your agent (or you) handle the rest
flue add daytona --print

# Or pipe directly to a coding agent
flue add daytona --print | claude
```

This drops a `connectors/daytona.ts` file into your workspace (under `.flue/connectors/` if you're using the `.flue/` layout, or `connectors/` at the project root otherwise) and reminds you to install Daytona's TypeScript SDK:

```bash
npm install @daytona/sdk
```

The connector is a TypeScript adapter that wraps a Daytona sandbox into Flue's `SandboxFactory` interface — see the [sandbox connector spec](./sandbox-connector-spec.md) for the contract.

## Use Daytona in your agent

Instead of letting `init()` spin up a default virtual sandbox, create a Daytona sandbox yourself and pass it to `init()`. Three things change in your agent file:

1. Import `Daytona` from `@daytona/sdk` and `daytona` from your connector file.
2. Create a Daytona client and sandbox.
3. Pass `sandbox: daytona(sandbox)` to `init()`.

Applied to the Hello World agent from the deploy guides:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../connectors/daytona';

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();

  const agent = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

`cleanup: true` tells Flue to delete the sandbox when the session ends. The default is `false` (you manage the lifecycle), and you can also pass a function for custom teardown.

## Advanced: Sharing a sandbox across sessions

If your agent needs the sandbox in a specific state before prompting — a repo cloned, dependencies installed, config files written — do the setup in one session, then spin up a second `init()` for the working session with the right `cwd`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../connectors/daytona';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();

  // Setup session — clone the repo and install dependencies.
  const setupAgent = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const setup = await setupAgent.session();
  await setup.shell(`git clone ${payload.repo} /workspace/project`);
  await setup.shell('npm install', { cwd: '/workspace/project' });

  // Working session — same sandbox, but rooted at the project directory.
  const projectAgent = await init({
    id: 'project',
    sandbox: daytona(sandbox),
    cwd: '/workspace/project',
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await projectAgent.session();

  return await session.prompt(payload.prompt);
}
```

Both `init()` calls share the same Daytona sandbox. Only the first carries `cleanup: true` so the sandbox is torn down when the working session ends. The second passes `cwd` so the agent's tools operate inside the project directory.

## Configuring the sandbox

Anything you'd configure on a Daytona sandbox — image, region, env vars, volumes — happens in your code against the Daytona SDK, before you hand the sandbox to `daytona()`. A few common knobs:

- **Image or snapshot.** `client.create()` boots from Daytona's default snapshot. To use a different snapshot, pass `client.create({ snapshot: 'my-snapshot-id' })`. To boot from a Docker image, pass `client.create({ image: 'debian:12.9' })` — Daytona builds a snapshot from the image on first use. For declarative image builds, see [Daytona's snapshots docs](https://www.daytona.io/docs/en/snapshots) and [declarative builder docs](https://www.daytona.io/docs/en/declarative-builder).
- **Region / target.** Pass `target: 'us'` or `target: 'eu'` to the `Daytona` client constructor (or set `DAYTONA_TARGET` in your environment). See [Daytona's regions docs](https://www.daytona.io/docs/en/regions).
- **Env vars on the sandbox.** Pass `envVars` at sandbox creation time — for example, `client.create({ envVars: { NODE_ENV: 'development' } })`.

For anything beyond this, treat [Daytona's documentation](https://www.daytona.io/docs/en/typescript-sdk/daytona/) as the source of truth.

## Run it

Once your agent is wired up and `DAYTONA_API_KEY` is set, the dev command from your prerequisite guide just works — no Daytona-specific runtime flags to remember. The first sandbox creation may take a few seconds while Daytona provisions; subsequent runs against cached images are faster.

## Troubleshooting

If you run into anything specific to the Daytona side of this setup — sandbox provisioning, image builds, regions, account or billing questions — the Daytona team and community are the best place to go:

- [Daytona docs](https://www.daytona.io/docs/) — full reference.
- [TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/daytona/) — for the SDK calls used in this guide.
- [Daytona Slack community](https://go.daytona.io/slack) — fastest way to ask questions and reach the team.
- [daytonaio/daytona on GitHub](https://github.com/daytonaio/daytona) — issues and source.
- [Daytona status](https://status.app.daytona.io/) — service health.

For Flue-specific questions (the connector, the SDK, agent wiring), open an issue on [withastro/flue](https://github.com/withastro/flue).
