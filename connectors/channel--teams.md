---
{
  "category": "channel",
  "website": "https://www.microsoft.com/microsoft-teams"
}
---

# Add a Microsoft Teams Channel to Flue

You are an AI coding agent adding authenticated Microsoft Teams Bot Connector
activities and project-owned outbound messaging to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
the activity families the application needs.

Install `@flue/teams`. Do not install `@microsoft/agents-hosting` or
`@microsoft/teams.apps` as the canonical client: their current packages declare
Node runtimes and depend on Node-oriented MSAL, JWT, HTTP, or Express
infrastructure. Use the documented OAuth client-credentials and Bot Connector
REST protocols through Fetch so the integration works on Node and Cloudflare
Workers.

## Create the Fetch client

Create `<source-dir>/lib/teams-client.ts`. Keep helpers outside the immediate
`channels/` directory because every file there is discovered as a channel
module. Implement and export a narrow
`createTeamsClient(...)` that:

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
input, event policy, and tool:

```ts
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
    description: 'Post a message to the Microsoft Teams conversation bound to this agent.',
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

Messages, conversation updates, invoke activities, and reactions have typed
variants. Other authenticated activity types arrive as `type: 'unknown'`.
Returning nothing produces an empty `200`; return JSON for an invoke body or
use the Hono context for explicit status and response control.

## Wire the agent

```ts
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/teams.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers.

## Credentials and verification

`TEAMS_APP_ID` constrains the Bot Connector JWT audience.
`TEAMS_TENANT_ID` constrains activity tenant identity.
`TEAMS_APP_PASSWORD` authenticates outbound OAuth client credentials.

The package defaults to Microsoft's public-cloud OpenID metadata and token
issuer. For a supported sovereign cloud, pass its documented metadata URL and
issuer to `createTeamsChannel(...)` and configure the matching OAuth authority
in the project-owned client. Follow the project's secret conventions and never
invent values.

Set the Azure Bot messaging endpoint to:

```txt
https://example.com/channels/teams/activities
```

If `flue()` has an outer mount prefix, include it in the configured URL.
Bots receive channel messages when mentioned by default. Add the appropriate
Teams resource-specific consent permissions only when the application needs all
channel or group-chat messages.

Run the project's typecheck and both Node and Cloudflare builds. Generate a
local RSA key pair, OpenID metadata, JWKS, and signed Bot Connector JWTs. Test
valid and invalid audience, issuer, expiry, endorsement, service URL, tenant,
and activity payloads. Exercise OAuth and one outbound message against an
injected local Fetch transport. Do not contact Microsoft services.
