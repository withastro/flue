---
{
  "kind": "channel",
  "version": 1,
  "website": "https://discord.com"
}
---

# Add a Discord Channel to Flue

You are an AI coding agent adding verified Discord HTTP interactions and
application-owned Discord REST behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and the interaction commands the
application supports.

Install `@flue/discord` and `@discordjs/rest@^2.6.1`. Discord does not publish an
official JavaScript REST SDK; `@discordjs/rest` is the
dominant community-maintained REST client. Do not add Discord Gateway or a
long-lived bot connection for outbound REST calls.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/discord.ts`. Adapt the imported agent, command
name, dispatched message, immediate response, and application-owned destination
derivation:

```ts
// flue-blueprint: channel/discord@1
import { REST } from '@discordjs/rest';
import * as v from 'valibot';
import {
  createDiscordChannel,
  type APIInteraction,
  type APIInteractionResponse,
  type DiscordDestinationRef,
} from '@flue/discord';
import { defineTool, dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';

export const client = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    if (interaction.type !== 2 || interaction.data.name !== 'ask') {
      return {
        type: 4,
        data: { content: 'Unsupported interaction.', flags: 64 },
      } satisfies APIInteractionResponse;
    }

    const destination = destinationFromInteraction(interaction);
    if (!destination || destination.type === 'private') {
      return {
        type: 4,
        data: { content: 'Unsupported interaction.', flags: 64 },
      } satisfies APIInteractionResponse;
    }

    // The first string option of the `/ask` chat-input command is the prompt.
    const question =
      interaction.data.type === 1
        ? interaction.data.options?.find((option) => option.type === 3)?.value
        : undefined;
    const channelName = interaction.channel?.name ?? undefined;
    await dispatch(Assistant, {
      id: channel.instanceId(destination),
      // Recorded once when this event creates the instance; ignored after.
      initialData: {
        channelId: destination.channelId,
        ...(channelName === undefined ? {} : { channelName }),
      },
      message: {
        kind: 'signal',
        type: 'discord.command.ask',
        body: question ?? JSON.stringify(interaction.data),
        attributes: { interactionId: interaction.id, commandName: interaction.data.name },
      },
    });
    return {
      type: 4,
      data: { content: 'Your request was accepted.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});

export function postMessage(ref: { channelId: string }) {
  return defineTool({
    name: 'post_discord_message',
    description: 'Post a message to the Discord destination bound to this agent.',
    input: v.object({ content: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { content } = data;
      const result = (await client.post(`/channels/${ref.channelId}/messages`, {
        body: { content },
      })) as { id?: string };
      return { ...(result.id === undefined ? {} : { messageId: result.id }) };
    },
  });
}

function destinationFromInteraction(interaction: APIInteraction): DiscordDestinationRef | undefined {
  const channelId = interaction.channel?.id ?? interaction.channel_id;
  if (!channelId) return undefined;
  if (interaction.guild_id) {
    return { type: 'guild', guildId: interaction.guild_id, channelId };
  }
  if (interaction.context === 2 || interaction.channel?.type === 3) {
    return { type: 'private', channelId };
  }
  if (interaction.context === 1 || interaction.channel?.type === 1) {
    return { type: 'dm', channelId };
  }
  return undefined;
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/discord.ts';

const app = new Hono();
app.route('/channels/discord', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/discord` mount; a different mount path shifts every
provider URL accordingly.

This application-owned helper derives `DiscordDestinationRef` from native
`guild_id`, `channel.id`, deprecated `channel_id`, `channel.type`, and `context`
fields. Discord interactions require a provider
response; do not rely on an empty acknowledgement. PING/PONG is handled by
`@flue/discord`. Keep the native `interaction.token` out of the dispatched
message, tools, model context, logs, and durable history. Some valid
interactions have no durable destination, and private-channel interactions
cannot be used as arbitrary bot-token message destinations.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the structured destination facts — the agent reads them
with `useInitialData()` instead of parsing the instance id — plus small
instance-constant context like the channel name. Per-message facts stay on the
signal's `attributes`.

The package-root `@discordjs/rest` import selects its Fetch-based web export in
Cloudflare Workers. Follow the project's Worker secret binding convention and
verify the actual Worker build. Do not expose arbitrary channel ids, routes, or
bot tokens to the model.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/discord.ts';

const initialDataSchema = v.object({
	channelId: v.string(),
	channelName: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Discord channel dispatch.');
	useTool(postMessage(data));
	const channelName = data.channelName ? ` #${data.channelName}` : '';
	return `Post a concise answer to the bound Discord destination${channelName}.`;
}

Assistant.initialData = initialDataSchema;
```

The `initialData` static validates the dispatched `initialData` when the
instance is created; `useInitialData()` returns the parsed value on every
render.

The `'use agent'` directive (the module's first statement) is what registers
the agent with the application — `dispatch(...)` from the channel callback
needs no `app.ts` mounting. Add
`app.route('/agents/<name>', createAgentRouter(Assistant))` (from
`@flue/runtime/routing`) in `app.ts` only when the agent
should also be reachable over HTTP directly.

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and agent function bodies.

## Credentials and verification

`DISCORD_PUBLIC_KEY` verifies inbound Ed25519 signatures.
`DISCORD_BOT_TOKEN` authenticates outbound REST calls. Follow project secret
conventions and never invent values.

After deployment, configure the Discord application's Interactions Endpoint URL
to the full public HTTPS interactions route — the channel's mount path in
`app.ts` plus the route suffix, so `/channels/discord/interactions` with the
conventional `app.route('/channels/discord', ...)` mount. Registering
application commands is also application-owned; add only the commands this
project handles.

Run the project typecheck and `vite build` for the configured target. Generate
a local Ed25519 key pair and signed PING and command payloads. Test changed bytes, malformed
authentication, PING/PONG, `/channels/discord/interactions`, provider-native
payload pass-through, and the deferred channel-agent import cycle. Exercise the
real `@discordjs/rest` client against a fail-closed fake Fetch transport in Node
and workerd. Do not contact Discord.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
