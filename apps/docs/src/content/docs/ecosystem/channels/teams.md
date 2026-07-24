---
title: Microsoft Teams
description: Receive authenticated Teams activities and use a project-owned Bot Connector client.
package:
  name: '@flue/teams'
  href: https://www.npmjs.com/package/@flue/teams
lastReviewedAt: 2026-07-21
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
import { Assistant } from '../agents/assistant.ts';

export const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  tenantId: process.env.TEAMS_TENANT_ID!,
  async activities({ activity }) {
    if (activity.type !== 'message' || !activity.text) return;
    await dispatch(Assistant, {
      id: channel.instanceId(channel.destination(activity)),
      message: {
        kind: 'signal',
        type: 'teams.message',
        body: activity.text,
        attributes: {
          ...(activity.id === undefined ? {} : { activityId: activity.id }),
          senderId: activity.from.id,
          senderName: activity.from.name,
        },
      },
    });
  },
});
```

The abridged example omits the generated client and message tool. Once
configured, a text activity continues the agent instance for its verified Teams
conversation, and the bound tool can post a reply to the same Connector service
URL and thread. The generated Fetch client runs on Node and Cloudflare Workers.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as teams } from './channels/teams.ts';

app.route('/channels/teams', teams.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/teams` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

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
import { createTeamsChannel } from '@flue/teams';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { createTeamsClient, type TeamsMessageRef } from '../lib/teams-client.ts';

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
        const destination = channel.destination(activity);
        await dispatch(Assistant, {
          id: channel.instanceId(destination),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            serviceUrl: destination.serviceUrl,
            conversationId: destination.conversationId,
            botId: destination.botId,
            ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }),
          },
          message: {
            kind: 'signal',
            type: 'teams.message',
            body: activity.text,
            attributes: {
              ...(activity.id === undefined ? {} : { activityId: activity.id }),
              senderId: activity.from.id,
              senderName: activity.from.name,
            },
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function postMessage(ref: TeamsMessageRef) {
  return defineTool({
    name: 'post_teams_message',
    description: 'Post to the Microsoft Teams conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const result = await client.postMessage(ref, text);
      return { activityId: result.id };
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
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/teams.ts';

const initialData = v.object({
  serviceUrl: v.string(),
  conversationId: v.string(),
  botId: v.string(),
  threadId: v.optional(v.string()),
});

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the Microsoft Teams channel dispatch.');
  useTool(postMessage(data));
  return 'Reply concisely in the bound Microsoft Teams conversation.';
}

Assistant.initialData = initialData;
```

The model selects only message text. Trusted code binds the Connector service
URL, conversation, bot account, and channel thread as the instance's creation
data — the agent reads them with `useInitialData()` instead of parsing the
instance id.

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
