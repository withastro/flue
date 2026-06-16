# Microsoft Teams Channel

Use this for `@flue/teams`, Bot Connector activities, Teams authentication, and conversation-bound reply tools.

## Setup

- Run `flue add channel teams`.
- Use `@flue/teams` for authenticated Bot Connector ingress.
- Use the generated Fetch Bot Connector client for outbound messages.
- Required environment:
  - `TEAMS_APP_ID`
  - `TEAMS_TENANT_ID`
  - `TEAMS_APP_PASSWORD`
- Configure Azure Bot messaging endpoint: `https://example.com/channels/teams/activities`.

The blueprint uses documented OAuth and Bot Connector REST protocols through Fetch so the integration can run on Node and Cloudflare Workers.

## Activities

- Route: `/channels/teams/activities`.
- Callback receives provider-native Bot Framework `Activity`.
- Switch on `activity.type`, such as `message`, `conversationUpdate`, `invoke`, and `messageReaction`.
- Use `channel.destination(activity)` to derive canonical reply identity.
- `invoke` activities expect a JSON acknowledgement body.
- Azure Bot Service retries on non-2xx responses; return 2xx after work is safely admitted.

## Authentication

`@flue/teams` verifies:

- Microsoft OpenID signing key and `RS256` signature.
- Issuer, application audience, and expiration.
- Signing key `msteams` endorsement.
- Activity `serviceUrl` against signed token claim.
- Host conversation and channel tenant against `TEAMS_TENANT_ID`.

Sovereign deployments can provide documented OpenID metadata URL, token issuer, and OAuth authority.

## Conversation And Tools

- Use `channel.conversationKey(channel.destination(activity))` for conversation-scoped agent IDs.
- Bind reply tools with `channel.parseConversationKey(id)`.
- Trusted code binds tenant, Connector service URL, conversation, bot account, and thread.
- The model selects only message text.
- Conversation keys validate syntax, not authorization; keep the agent dispatch-only or authorize caller-selected IDs separately.
- Claim activity IDs in application storage before dispatch when duplicate admission matters.

