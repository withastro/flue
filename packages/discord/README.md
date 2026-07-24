# `@flue/discord`

Verified Discord HTTP interactions ingress for Flue applications.

```ts
import { createDiscordChannel, type APIInteractionResponse } from '@flue/discord';

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    await handleInteraction(interaction);
    return {
      type: 4,
      data: { content: 'Accepted.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});
```

Place this export in `channels/discord.ts`. Flue discovers it and serves
`POST /channels/discord/interactions` relative to the `flue()` mount.

The package verifies Ed25519 signatures over exact request bytes, handles
PING/PONG internally, and passes authenticated interactions through with
Discord's field names, nesting, and numeric discriminants. It re-exports the
Discord API v10 interaction and response types from `discord-api-types`.

This package does not include an outbound Discord client, response builder, or
model tools. Run `flue add channel discord` to generate editable project code using
`@discordjs/rest` and application-owned `defineTool(...)` values.

Instance ids identify application-derived guild destinations, bot DMs,
and private-channel contexts. Instance ids are not authorization
capabilities. The package is stateless and does not deduplicate interaction ids.
