---
title: Microsoft Teams
description: Receive authenticated Teams activities and use a project-owned Bot Connector client.
---

## Add Microsoft Teams

Run the Teams recipe through your coding agent:

```sh
flue add teams --print | codex
```

It installs `@flue/teams` for authenticated Bot Connector ingress and creates a
project-owned Fetch client for outbound messages.

Microsoft's current JavaScript Agents and Teams SDKs declare Node runtimes and
use Node-oriented authentication or hosting packages. The recipe uses the same
documented OAuth client-credentials and Bot Connector REST protocols directly
through Fetch so the integration runs on Node and Cloudflare Workers.

Set the Azure Bot messaging endpoint to:

```txt
https://example.com/channels/teams/activities
```

`TEAMS_APP_ID` constrains the inbound JWT audience.
`TEAMS_TENANT_ID` constrains activity tenant identity.
`TEAMS_APP_PASSWORD` authenticates outbound OAuth requests.

Teams bots receive channel messages when mentioned by default. Configure the
appropriate Teams resource-specific consent permissions when the application
must receive all channel or group-chat messages.

## Channel module

```ts title="src/channels/teams.ts"
import { defineTool, dispatch } from '@flue/runtime';
import { createTeamsChannel, type TeamsConversationRef } from '@flue/teams';
import assistant from '../agents/assistant.ts';
import { createTeamsClient } from '../lib/teams-client.ts';

const appId = process.env.TEAMS_APP_ID!;
const tenantId = process.env.TEAMS_TENANT_ID!;

export const client = createTeamsClient({
  appId,
  tenantId,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
});

export const channel = createTeamsChannel({
  appId,
  tenantId,

  // Path: /channels/teams/activities
  async activities({ activity }) {
    switch (activity.type) {
      case 'message': {
        if (!activity.payload.text) return;
        await dispatch(assistant, {
          id: channel.conversationKey(activity.destination),
          input: {
            type: 'teams.message',
            activityId: activity.activityId,
            sender: activity.sender,
            text: activity.payload.text,
            mentions: activity.payload.mentions,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function postMessage(ref: TeamsConversationRef) {
  return defineTool({
    name: 'post_teams_message',
    description: 'Post to the Microsoft Teams conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const result = await client.postMessage(ref, text);
      return JSON.stringify({ activityId: result.id });
    },
  });
}
```

The generated `lib/teams-client.ts` exchanges the application credentials for a
Bot Connector token, caches it until shortly before expiry, and sends message
activities through the verified destination's Connector service URL.

Messages, conversation updates, invoke activities, and reactions have typed
variants. Other authenticated activity types arrive as `type: 'unknown'`.
Return nothing for an empty `200`, return JSON for a provider body, or use the
Hono context for explicit status control.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/teams.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The model selects only message text. Trusted code binds the tenant, Connector
service URL, conversation, bot account, and channel thread.

Conversation keys validate syntax, not authorization. Keep this agent
dispatch-only, or independently authorize caller-selected instance ids before
using them for outbound requests.

## Authentication

`@flue/teams` verifies the Bot Connector bearer token before invoking the
handler. It checks:

- the Microsoft OpenID signing key and `RS256` signature;
- issuer, application audience, and expiration;
- the signing key's `msteams` endorsement;
- the activity's exact `serviceUrl` against the signed token claim;
- the host conversation and channel tenant against `TEAMS_TENANT_ID`.

The defaults target Microsoft's public cloud. Supported sovereign deployments
can provide their documented OpenID metadata URL, token issuer, and OAuth
authority.

The package does not deduplicate activity ids. Claim them in application-owned
durable storage before dispatch when duplicate admission is unacceptable.

See the [`@flue/teams` API reference](/docs/api/teams-channel/).
