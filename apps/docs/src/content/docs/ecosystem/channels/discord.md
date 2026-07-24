---
title: Discord
description: Receive verified Discord interactions and use a project-owned REST client.
package:
  name: '@flue/discord'
  href: https://www.npmjs.com/package/@flue/discord
lastReviewedAt: 2026-07-21
---

## Quickstart

Add verified Discord HTTP interactions and application-owned Discord REST behavior to an existing Flue project with the [Discord](https://discord.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel discord
```

## Overview

The blueprint installs `@flue/discord` and the community-maintained
`@discordjs/rest` client. It creates a source-root `channels/discord.ts` module
that verifies interactions, dispatches supported commands, exports a
project-owned REST client and message tool, and modifies the selected agent to
bind that tool to the interaction's trusted destination.

```ts title="src/channels/discord.ts (abridged)"
import { REST } from '@discordjs/rest';
import { createDiscordChannel, type APIInteractionResponse } from '@flue/discord';
import { dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';

export const client = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,
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
    await dispatch(Assistant, {
      id: channel.instanceId(destination),
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
```

The abridged example omits the generated `destinationFromInteraction` helper
and message tool. Once configured, an `ask` command continues the agent instance
for its Discord destination, acknowledges the interaction, and lets that agent
post messages through the bound REST tool. On Cloudflare Workers, the REST
package selects its Fetch-based export and uses Flue's `nodejs_compat` setting.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as discord } from './channels/discord.ts';

app.route('/channels/discord', discord.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/discord` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable             | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `DISCORD_PUBLIC_KEY` | **Required** — Verifies inbound interaction request bytes. |
| `DISCORD_BOT_TOKEN`  | **Required** — Authenticates outbound Discord REST calls.  |

The blueprint installs and configures `@flue/discord` for inbound HTTP
interactions, along with a project-owned `@discordjs/rest` client for outbound
API calls. After running the command, you will have a new source-root
`channels/discord.ts` module exporting `channel` and `client`.

Discord does not publish an official JavaScript REST SDK. The blueprint uses the
community-maintained `@discordjs/rest` client. Your application owns that client
and its outbound API calls; `@flue/discord` handles only verified inbound HTTP
interactions.

In the Discord Developer Portal, set the application's Interactions Endpoint
URL to the full public HTTPS route:

```txt
https://example.com/channels/discord/interactions
```

Register only the application commands your project handles. Endpoint and
command registration are provider setup owned by the application, not by the
channel package.

## Supported HTTP interaction

| Discord surface | Webhook path                     |
| --------------- | -------------------------------- |
| Interactions    | `/channels/discord/interactions` |

Discord can deliver [interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
through the Gateway or an outgoing webhook, but not both for the same
application. `@flue/discord` implements the verified HTTP path. Discord Gateway
is a persistent WebSocket transport and remains outside the channel model.

Signed PING requests are answered with PONG internally before application code
runs.

### Interactions

```ts title="src/channels/discord.ts"
import { type APIInteractionResponse, createDiscordChannel } from '@flue/discord';

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    if (interaction.type === 4) {
      return {
        type: 8,
        data: { choices: [] },
      } satisfies APIInteractionResponse;
    }

    if (interaction.type === 2 && interaction.data.name === 'ask') {
      return {
        type: 4,
        data: { content: 'Your request was accepted.', flags: 64 },
      } satisfies APIInteractionResponse;
    }

    return {
      type: 4,
      data: { content: 'Unsupported interaction.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});
```

`interaction` is Discord's provider-native API v10 object. Its numeric `type`
discriminant narrows commands, autocomplete requests, message components, and
modal submissions while preserving Discord's snake_case fields and nesting.
The package does not filter authenticated interaction families; the handler
decides which ones affect the application.

The callback uses the current `APIInteraction` union for strong narrowing.
Authenticated future numeric types are still forwarded at runtime, so an
exhaustive branch should tolerate an unfamiliar numeric value after a Discord
API change.

### Respond within Discord's deadline

Every non-PING HTTP interaction requires a valid Discord interaction response.
Discord invalidates the interaction token if the initial response is not sent
within three seconds. The package awaits the application handler and does not
impose a separate timeout, so admit durable work promptly and return within that
provider deadline.

An immediate message response uses callback type `4`. A deferred response uses
type `5` when the application will complete the interaction through Discord's
webhook API. Interaction tokens remain valid for follow-up operations for up to
15 minutes.

`interaction.token` is a short-lived response capability. Use it only in
immediate trusted application code. Keep it out of the dispatched message, model
context, logs, and durable session history.

See Discord's [interaction callback documentation](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)
for the response types allowed by each interaction family.

### Choose a conversation destination

Not every interaction represents a durable Discord channel conversation. When
an interaction should continue an agent instance, application code can derive a
`DiscordDestinationRef` from native `guild_id`, `channel.id`, `channel.type`, and
`context` fields. The complete generated example from `flue add channel discord` shows
that derivation and dispatches with `channel.instanceId(ref)`.

Some valid interactions, including modal submissions, may omit a channel.
Private-channel interactions can be acknowledged through their interaction
token, but that capability does not grant the bot arbitrary channel-message
access.

Use `channel.instanceId(ref)` when a Discord destination should continue
the same agent instance. Instance ids are identifiers, not authorization
capabilities. See the shared [Channels guide](/docs/guide/channels/) for dispatch,
authorization, and deduplication guidance.

## Outbound REST

Outbound Discord behavior belongs to the exported project-owned client:

```ts title="src/channels/discord.ts"
import { REST } from '@discordjs/rest';

export const client = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);
```

Bot-token messages, application-command registration, and interaction-token
follow-ups or edits are Discord REST operations. They are not implemented by
`@flue/discord`.

## Discord Tools

Use the client to define an application-owned tool with its destination bound in
trusted code:

```ts title="src/channels/discord.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export function postMessage(ref: { channelId: string }) {
  return defineTool({
    name: 'post_discord_message',
    description: 'Post to the Discord destination bound to this agent.',
    input: v.object({ content: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { content } }) {
      const result = (await client.post(`/channels/${ref.channelId}/messages`, {
        body: { content },
      })) as { id?: string };
      return { messageId: result.id ?? null };
    },
  });
}
```

`data` is the instance's creation data, recorded once when the dispatching
event creates the instance. Bind it when creating the agent instead of parsing
the instance id:

```ts title="src/agents/assistant.ts"
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/discord.ts';

const initialData = v.object({ channelId: v.string() });

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the Discord channel dispatch.');
  useTool(postMessage(data));
  return 'Post a concise answer to the bound Discord destination.';
}

Assistant.initialData = initialData;
```

The model selects message content. It does not select arbitrary Discord
channels, credentials, or REST methods. This tool creates an ordinary bot-token
channel message, not an interaction follow-up or guaranteed ephemeral response.
`parseInstanceId()` remains available as an escape hatch for recovering the
destination from the id directly.

## Delivery and runtime behavior

Discord does not document dependable interaction redelivery behavior. The
channel rejects signed requests whose timestamp is more than five minutes from
the server clock, which bounds how stale a replay can be, but it is otherwise
stateless and does not deduplicate interaction ids. Preserve `interaction.id`
for tracing, and claim it in application-owned durable storage before dispatch
when duplicate admission is unacceptable.

`@flue/discord` runs in Node and Cloudflare Workers with Flue's required
`nodejs_compat` setting. The example executes `@discordjs/rest` channel-message
request construction against a fail-closed fake Fetch transport in both
runtimes. Validate any additional REST operations your application depends on.
