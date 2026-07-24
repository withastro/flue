---
{
  "kind": "channel",
  "version": 1,
  "website": "https://www.microsoft.com/microsoft-teams"
}
---

# Add a Microsoft Teams Channel to Flue

You are an AI coding agent adding authenticated Microsoft Teams Bot Connector
activities and project-owned outbound messaging to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and the activity families the
application needs.

Install `@flue/teams`. Do not install `@microsoft/agents-hosting` or
`@microsoft/teams.apps` as the canonical client: their current packages declare
Node runtimes and depend on Node-oriented MSAL, JWT, HTTP, or Express
infrastructure. Use the documented OAuth client-credentials and Bot Connector
REST protocols through Fetch so the integration works on Node and Cloudflare
Workers.

Install `valibot` using the project's existing dependency conventions.

## Create the Fetch client

Create `<source-dir>/lib/teams-client.ts`. Keep helpers outside the
`channels/` directory so channel modules stay focused on ingress. Implement
and export a narrow `createTeamsClient(...)` that:

- exchanges `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, and `TEAMS_TENANT_ID` at
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`;
- requests `https://api.botframework.com/.default` with
  `grant_type=client_credentials`;
- caches the access token until shortly before `expires_in`;
- posts message activities beneath the verified destination's
  `<serviceUrl>/v3/conversations/<conversationId>/activities`;
- appends `/<threadId>` for a channel-thread reply;
- binds `conversationId`, `threadId`, `botId`, and `serviceUrl` from trusted
  application code rather than model arguments;
- uses an injectable Fetch implementation for local and workerd tests.

Validate OAuth and Connector response status and shape. Never contact a service
URL supplied directly by a model or unauthenticated caller.

## Create the channel

Create `<source-dir>/channels/teams.ts`. Adapt the imported agent, dispatched
message, event policy, and tool:

```ts
// flue-blueprint: channel/teams@1
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { createTeamsChannel } from '@flue/teams';
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
    if (activity.type !== 'message' || !activity.text) return;
    const destination = channel.destination(activity);
    await dispatch(Assistant, {
      id: channel.instanceId(destination),
      // Recorded once when this event creates the instance; ignored after.
      initialData: {
        serviceUrl: destination.serviceUrl,
        conversationId: destination.conversationId,
        botId: destination.botId,
        ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }),
        ...(activity.conversation.name === undefined
          ? {}
          : { conversationName: activity.conversation.name }),
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
  },
});

export function postMessage(ref: TeamsMessageRef) {
  return defineTool({
    name: 'post_teams_message',
    description: 'Post a message to the Microsoft Teams conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const result = await client.postMessage(ref, text);
      return { activityId: result.id };
    },
  });
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/teams.ts';

const app = new Hono();
app.route('/channels/teams', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comment in this guide assumes the
conventional `/channels/teams` mount; a different mount path shifts every
provider URL accordingly.

The callback receives the provider-native Bot Framework `Activity` (typed by
`botframework-schema`). Derive the canonical routing identity with
`channel.destination(activity)` when you need to address a reply. Switch on
`activity.type` (`message`, `conversationUpdate`, `invoke`, `messageReaction`,
and other Bot Framework types) using Microsoft's documented field names.
Returning nothing produces an empty `200`; return JSON for an invoke response
body or use the Hono context for explicit status and response control.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the destination facts the outbound tool needs to reach
the conversation — the agent reads them with `useInitialData()` instead of
parsing the instance id — plus small instance-constant context like the
conversation's display name. Per-message facts stay on the signal's
`attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/teams.ts';

const initialDataSchema = v.object({
	serviceUrl: v.string(),
	conversationId: v.string(),
	botId: v.string(),
	threadId: v.optional(v.string()),
	conversationName: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Microsoft Teams channel dispatch.');
	useTool(postMessage(data));
	const conversationName = data.conversationName ? ` "${data.conversationName}"` : '';
	return `Reply concisely in the bound Microsoft Teams conversation${conversationName}.`;
}

Assistant.initialData = initialDataSchema;
```

The `initialData` static validates the dispatched `initialData` when the
instance is created; `useInitialData()` returns the parsed value on every
render.

The `'use agent'` directive (the module's first statement) is what registers
the agent with the application — `dispatch(...)` from the channel callback
needs no `app.ts` mounting. Add
`app.route('/agents/<name>', createAgentRouter(Assistant))` (from
`@flue/runtime/routing`) in `app.ts` only when the agent
should also be reachable over HTTP directly.

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and agent function bodies.

## Credentials and verification

`TEAMS_APP_ID` constrains the Bot Connector JWT audience.
`TEAMS_TENANT_ID` constrains activity tenant identity.
`TEAMS_APP_PASSWORD` authenticates outbound OAuth client credentials.

The package defaults to Microsoft's public-cloud OpenID metadata and token
issuer. For a supported sovereign cloud, pass its documented metadata URL and
issuer to `createTeamsChannel(...)` and configure the matching OAuth authority
in the project-owned client. Follow the project's secret conventions and never
invent values.

Set the Azure Bot messaging endpoint to the channel's mount path in `app.ts`
plus the route suffix — with the conventional
`app.route('/channels/teams', ...)` mount:

```txt
https://example.com/channels/teams/activities
```

A different mount path changes the configured URL accordingly.
Bots receive channel messages when mentioned by default. Add the appropriate
Teams resource-specific consent permissions only when the application needs all
channel or group-chat messages.

Run the project typecheck and `vite build` for the configured target. Generate
a local RSA key pair, OpenID metadata, JWKS, and signed Bot Connector JWTs. Test
valid and invalid audience, issuer, expiry, endorsement, service URL, tenant,
and activity payloads. Exercise OAuth and one outbound message against an
injected local Fetch transport. Do not contact Microsoft services.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
