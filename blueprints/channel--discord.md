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
`<root>/`. Inspect existing agents, environment types, secret conventions, and
the interaction commands the application supports.

Install `@flue/discord` and `@discordjs/rest@^2.6.1`. Discord does not publish an
official JavaScript REST SDK; `@discordjs/rest` is the
dominant community-maintained REST client. Do not add Discord Gateway or a
long-lived bot connection for outbound REST calls.

## Create the channel

Create `<source-dir>/channels/discord.ts`. Adapt the imported agent, command
name, dispatched input, immediate response, and application-owned destination
derivation:

```ts
// flue-blueprint: channel/discord@1
import { REST } from '@discordjs/rest';
import {
  createDiscordChannel,
  type APIInteraction,
  type APIInteractionResponse,
  type DiscordDestinationRef,
} from '@flue/discord';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

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

    await dispatch(assistant, {
      id: channel.conversationKey(destination),
      input: {
        type: 'discord.command.ask',
        interactionId: interaction.id,
        data: interaction.data,
      },
    });
    return {
      type: 4,
      data: { content: 'Your request was accepted.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});

export function postMessage(ref: DiscordDestinationRef) {
  return defineTool({
    name: 'post_discord_message',
    description: 'Post a message to the Discord destination bound to this agent.',
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

This application-owned helper derives `DiscordDestinationRef` from native
`guild_id`, `channel.id`, deprecated `channel_id`, `channel.type`, and `context`
fields. Discord interactions require a provider
response; do not rely on an empty acknowledgement. PING/PONG is handled by
`@flue/discord`. Keep the native `interaction.token` out of dispatched input,
tools, model context, logs, and durable history. Some valid interactions have no
durable destination, and private-channel interactions cannot be used as
arbitrary bot-token message destinations.

The package-root `@discordjs/rest` import selects its Fetch-based web export in
Cloudflare Workers. Follow the project's Worker secret binding convention and
verify the actual Worker build. Do not expose arbitrary channel ids, routes, or
bot tokens to the model.

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers.

## Credentials and verification

`DISCORD_PUBLIC_KEY` verifies inbound Ed25519 signatures.
`DISCORD_BOT_TOKEN` authenticates outbound REST calls. Follow project secret
conventions and never invent values.

After deployment, configure the Discord application's Interactions Endpoint URL
to the full public HTTPS `/channels/discord/interactions` route. Registering
application commands is also application-owned; add only the commands this
project handles.

Run the project's typecheck and configured Flue builds. Generate a local Ed25519
key pair and signed PING and command payloads. Test changed bytes, malformed
authentication, PING/PONG, `/channels/discord/interactions`, provider-native
payload pass-through, and the deferred channel-agent import cycle. Exercise the
real `@discordjs/rest` client against a fail-closed fake Fetch transport in Node
and workerd. Do not contact Discord.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
