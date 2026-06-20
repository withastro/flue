---
title: Microsoft Teams
description: Receive authenticated Teams activities and use a project-owned Bot Connector client.
package:
  name: '@flue/teams'
  href: https://www.npmjs.com/package/@flue/teams
---

## Quickstart

Add authenticated Microsoft Teams Bot Connector activities and project-owned outbound messaging to an existing Flue project with the [Microsoft Teams](https://www.microsoft.com/microsoft-teams) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel teams
```

## Overview

The blueprint installs `@flue/teams`, creates a source-root
`lib/teams-client.ts` Fetch client and `channels/teams.ts` channel module, and
modifies the selected agent to bind the generated message tool. The Fetch client
handles OAuth token exchange and Bot Connector requests without adding
Microsoft's Node-oriented hosting SDKs.

```ts title="src/channels/teams.ts (abridged)"
import { dispatch } from '@flue/runtime';
import { createTeamsChannel } from '@flue/teams';
import assistant from '../agents/assistant.ts';

export const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  tenantId: process.env.TEAMS_TENANT_ID!,
  async activities({ activity }) {
    if (activity.type !== 'message' || !activity.text) return;
    await dispatch(assistant, {
      id: channel.conversationKey(channel.destination(activity)),
      input: {
        type: 'teams.message',
        activityId: activity.id,
        sender: activity.from,
        text: activity.text,
        entities: activity.entities,
      },
    });
  },
});
```

The abridged example omits the generated client and message tool. Once
configured, a text activity continues the agent instance for its verified Teams
conversation, and the bound tool can post a reply to the same Connector service
URL and thread. The generated Fetch client runs on Node and Cloudflare Workers.

## Configure

| Variable             | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `TEAMS_APP_ID`       | **Required** — Constrains the inbound JWT audience.   |
| `TEAMS_TENANT_ID`    | **Required** — Constrains activity tenant identity.   |
| `TEAMS_APP_PASSWORD` | **Required** — Authenticates outbound OAuth requests. |

It installs `@flue/teams` for authenticated Bot Connector ingress and creates a
project-owned Fetch client for outbound messages.

Microsoft's current JavaScript Agents and Teams SDKs declare Node runtimes and
use Node-oriented authentication or hosting packages. The blueprint uses the same
documented OAuth client-credentials and Bot Connector REST protocols directly
through Fetch so the integration runs on Node and Cloudflare Workers.

Set the Azure Bot messaging endpoint to:

```txt
https://example.com/channels/teams/activities
```

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
        if (!activity.text) return;
        await dispatch(assistant, {
          id: channel.conversationKey(channel.destination(activity)),
          input: {
            type: 'teams.message',
            activityId: activity.id,
            sender: activity.from,
            text: activity.text,
            entities: activity.entities,
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

The callback receives the provider-native Bot Framework `Activity`, re-exported
from `botframework-schema`. Switch on the native `activity.type` (`message`,
`conversationUpdate`, `invoke`, `messageReaction`, and other Bot Framework
types) and read Microsoft's documented field names. Call
`channel.destination(activity)` to derive the canonical routing identity when
you need to address a reply. Return nothing for an empty `200`, return JSON for
a provider body, or use the Hono context for explicit status control.

Azure Bot Service holds the inbound request open with a real response window, so
admit durable work quickly — `dispatch(...)` the activity and return, then rely
on idempotency rather than blocking the response on long-running work. `invoke`
activities expect a JSON acknowledgement body, and the Bot Connector retries on
any non-2xx response, so return a 2xx once the work is safely admitted.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/teams.ts';

export default defineAgent(({ id }) => ({
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

See the [`@flue/teams` README](https://github.com/withastro/flue/tree/main/packages/teams#readme).
