---
title: Discord
description: Configure Discord HTTP interactions, immediate responses, and bot-token posts.
---

`@flue/discord` implements an HTTP interaction bot. It does not connect to the
Discord Gateway or receive ordinary channel messages.

## Install and configure

```sh
pnpm add @flue/discord
```

Create a Discord application, add a bot, and collect the application id, public
key, and bot token. Install the bot with the permissions required to post in
the destinations your application supports. Register chat-input commands
separately through Discord's application command API.

Set the application's interactions endpoint URL to a public HTTPS route such
as:

```txt
https://example.com/webhooks/discord
```

See Discord's documentation for
[receiving interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
and [application commands](https://docs.discord.com/developers/interactions/application-commands).

```sh
DISCORD_PUBLIC_KEY=...
DISCORD_APPLICATION_ID=...
DISCORD_BOT_TOKEN=...
```

## Create the channel

```ts title="src/channels/discord.ts"
import { createDiscordChannel } from '@flue/discord';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const discord = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,
  applicationId: process.env.DISCORD_APPLICATION_ID!,
  botToken: process.env.DISCORD_BOT_TOKEN!,
});

discord.onCommand('ask', async (interaction) => {
  await dispatch(assistant, {
    id: discord.conversationKey(interaction.destination),
    input: {
      type: 'discord.command.ask',
      interactionId: interaction.id,
      data: interaction.data,
    },
  });

  return {
    type: 'message',
    message: { content: 'Your request was accepted.' },
    ephemeral: true,
  };
});
```

Never copy `interaction.token` or `interaction.raw` into dispatched input,
model-visible context, logs, or durable session history. They may contain
sensitive provider capabilities.

## Mount the interactions route

```ts title="src/app.ts"
app.mount('/webhooks/discord', discord.routes.interactions());
```

The route verifies the exact timestamp plus raw request bytes, handles PING
internally, and checks the signed application id before handlers run. Local
development requires a public HTTPS tunnel.

## Respond to components and modals

Use `onComponent(customId, ...)` for buttons and `onModal(customId, ...)` for
submitted modals. A component handler can return a message, update the current
message, or open a modal. A modal handler can return a message or update.

Immediate message responses disable parsed mentions by default. v1 message
components support action rows containing non-link buttons; modal responses
support Label components containing text inputs.

## Add a bot-token post tool

```ts title="src/agents/assistant.ts"
export default createAgent(({ id }) => ({
  tools: [discord.tools.postMessage(discord.parseConversationKey(id))],
}));
```

The tool posts an ordinary new message through the bot token. It is not an
interaction follow-up, edit, or guaranteed ephemeral response. Mention parsing
is disabled unless trusted application code enables specific mention classes
when creating the tool.

Supported destinations are guild text or announcement channels, guild threads,
and bot DMs. Unsupported private contexts are rejected before a handler runs.

Discord does not provide dependable redelivery after an interaction failure.
Claim interaction ids in application-owned storage when unique admission is
required.

See the [`@flue/discord` reference](/docs/api/discord-channel/) for response
types, components, clients, tools, and errors.
