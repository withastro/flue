---
title: Discord
description: Receive verified Discord interactions and use a project-owned REST client.
package:
  name: '@flue/discord'
  href: https://www.npmjs.com/package/@flue/discord
lastReviewedAt: 2026-06-13
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
import assistant from '../agents/assistant.ts';

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

    await dispatch(assistant, {
      id: channel.conversationKey(destination),
      input: { type: 'discord.command.ask', interactionId: interaction.id },
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
immediate trusted application code. Keep it out of dispatched input, model
context, logs, and durable session history.

See Discord's [interaction callback documentation](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)
for the response types allowed by each interaction family.

### Choose a conversation destination

Not every interaction represents a durable Discord channel conversation. When
an interaction should continue an agent instance, application code can derive a
`DiscordDestinationRef` from native `guild_id`, `channel.id`, `channel.type`, and
`context` fields. The complete generated example from `flue add channel discord` shows
that derivation and dispatches with `channel.conversationKey(ref)`.

Some valid interactions, including modal submissions, may omit a channel.
Private-channel interactions can be acknowledged through their interaction
token, but that capability does not grant the bot arbitrary channel-message
access.

Use `channel.conversationKey(ref)` when a Discord destination should continue
the same agent instance. Conversation keys are identifiers, not authorization
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
import type { DiscordDestinationRef } from '@flue/discord';

export function postMessage(ref: DiscordDestinationRef) {
  return defineTool({
    name: 'post_discord_message',
    description: 'Post to the Discord destination bound to this agent.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', minLength: 1 } },
      required: ['content'],
      additionalProperties: false,
    },
    async execute({ content }) {
      const result = (await client.post(`/channels/${ref.channelId}/messages`, {
        body: { content },
      })) as { id?: string };
      return JSON.stringify({ messageId: result.id });
    },
  });
}
```

Bind the destination when creating the agent:

```ts title="src/agents/assistant.ts"
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The model selects message content. It does not select arbitrary Discord
channels, credentials, or REST methods. This tool creates an ordinary bot-token
channel message, not an interaction follow-up or guaranteed ephemeral response.

## Delivery and runtime behavior

Discord does not document dependable interaction redelivery behavior. Preserve
`interaction.id` for tracing, and claim it in application-owned durable storage
before dispatch when duplicate admission is unacceptable. The channel itself is
stateless and does not deduplicate interaction ids.

`@flue/discord` runs in Node and Cloudflare Workers with Flue's required
`nodejs_compat` setting. The example executes `@discordjs/rest` channel-message
request construction against a fail-closed fake Fetch transport in both
runtimes. Validate any additional REST operations your application depends on.
