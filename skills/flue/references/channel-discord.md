# Discord Channel

Use this for `@flue/discord`, HTTP interactions, response deadlines, REST tools, and Discord destination keys.

## Setup

- Run `flue add channel discord`.
- Use `@flue/discord` for verified HTTP interactions.
- Use project-owned `@discordjs/rest` for outbound REST calls.
- Required environment:
  - `DISCORD_PUBLIC_KEY`
  - `DISCORD_BOT_TOKEN`
- Configure Interactions Endpoint URL: `https://example.com/channels/discord/interactions`.

Discord Gateway is a persistent WebSocket transport and is outside the Flue channel model.

## Interactions

- Supported route: `/channels/discord/interactions`.
- Signed PING requests are answered with PONG internally.
- `interaction` is Discord's provider-native API v10 object.
- Numeric `interaction.type` discriminates commands, autocomplete, components, and modal submissions.
- Preserve and branch on Discord's native fields.
- Authenticated future numeric types can still arrive at runtime; tolerate unfamiliar values.

## Deadlines And Tokens

- Every non-PING HTTP interaction requires a valid interaction response.
- Discord invalidates the interaction token if the initial response is not sent within three seconds.
- Return type `4` for immediate response or type `5` for deferred response.
- Interaction tokens remain valid for follow-up operations for up to 15 minutes.
- Keep `interaction.token` out of dispatch input, model context, logs, and durable session history.

## Destination And Tools

- Derive a destination from native guild, channel, channel type, and context fields.
- Some valid interactions omit a durable channel.
- Private-channel interactions may be acknowledged with their token but do not grant arbitrary bot message access.
- Use `channel.conversationKey(ref)` for destinations that should continue one agent instance.
- Bind REST tools with trusted destination and bot token; model chooses message content only.

