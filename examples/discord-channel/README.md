# Discord channel example

Example of verified Discord HTTP interactions at
`/channels/discord/interactions`, typed immediate responses, explicit dispatch
routing, destination identity, and one application-owned REST tool bound to the
agent's destination.

`DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN` are required when the built application starts. Builds and type checks do not require live credentials.

The channel module exports both the ingress `channel` and the project-owned
`@discordjs/rest` client. Discord does not publish an official JavaScript REST
SDK; this example uses the dominant community-maintained client. The message
tool is deliberately narrow application policy, not a generic tool supplied by
`@flue/discord`.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the interaction
callback and agent initializer, after module evaluation.

Instance ids validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.

The example dispatches only interactions with guild or bot-DM destinations.
Valid modal submissions may omit a destination, and private-channel
interactions cannot be used as arbitrary bot-token message destinations. A
bot-token post is a new ordinary message, not an interaction follow-up or an
ephemeral response.

The package-root `@discordjs/rest` import selects its Fetch-based web build in
Cloudflare Workers. Discord Gateway events and deferred interaction-token
replies remain application concerns. A public HTTPS tunnel is required for local webhook
development.
