---
{
  "kind": "channel",
  "version": 1,
  "website": "https://linear.app/developers"
}
---

# Add a Linear Channel to Flue

You are an AI coding agent adding verified Linear resource and agent-session
webhooks with project-owned outbound Linear API access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the application needs ordinary issue comments, Linear agent sessions,
or both.

Install `@flue/linear` and `@linear/sdk@^86.0.0`. Flue owns verified ingress.
The project owns the official SDK client and every outbound tool.

The current official SDK is used by Linear's own Cloudflare Workers agent
example with `nodejs_compat`. Flue's Cloudflare target supplies that
compatibility flag. Keep a workerd fake-transport test for every SDK operation
the project relies on.

## Create the channel

Create `<source-dir>/channels/linear.ts`. Adapt the imported agent, dispatched
input, event policy, and tool:

```ts
// flue-blueprint: channel/linear@1
import {
  createLinearChannel,
  type LinearConversationRef,
  type LinearWebhookPayload,
} from '@flue/linear';
import { defineTool, dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithCommentData,
} from '@linear/sdk/webhooks';
import assistant from '../agents/assistant.ts';

const organizationId = process.env.LINEAR_ORGANIZATION_ID;
const webhookId = process.env.LINEAR_WEBHOOK_ID;

export const client = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!,
});

export const channel = createLinearChannel({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  ...(organizationId ? { organizationId } : {}),
  ...(webhookId ? { webhookId } : {}),

  // Path: /channels/linear/webhook
  async webhook({ payload, deliveryId }) {
    if (isCommentEvent(payload)) {
      const comment = payload.data;
      if (payload.action !== 'create' || !comment.issueId) return;
      await dispatch(assistant, {
        id: channel.conversationKey({
          type: 'issue',
          organizationId: payload.organizationId,
          issueId: comment.issueId,
          ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
        }),
        input: {
          type: 'linear.comment.created',
          deliveryId,
          actor: payload.actor,
          comment,
        },
      });
      return;
    }

    if (isAgentSessionEvent(payload)) {
      await dispatch(assistant, {
        id: channel.conversationKey({
          type: 'agent-session',
          organizationId: payload.organizationId,
          agentSessionId: payload.agentSession.id,
        }),
        input: {
          type: `linear.agent_session.${payload.action}`,
          deliveryId,
          promptContext: payload.promptContext,
          activity: payload.agentActivity,
          session: payload.agentSession,
        },
      });
    }
  },
});

// Linear's native union has a catch-all member that keeps `type` widened, so a
// literal `type` check alone does not narrow. Combine it with a nested field.
function isCommentEvent(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithCommentData {
  return payload.type === 'Comment' && 'body' in payload.data;
}

function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === 'AgentSessionEvent' && 'agentSession' in payload;
}

export function postMessage(ref: LinearConversationRef) {
  return defineTool({
    name: 'post_linear_message',
    description: 'Post a message to the Linear conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      if (ref.type === 'agent-session') {
        const result = await client.createAgentActivity({
          agentSessionId: ref.agentSessionId,
          content: { type: 'response', body: text },
        });
        return JSON.stringify({ success: result.success });
      }

      const result = await client.createComment({
        issueId: ref.issueId,
        ...(ref.threadCommentId ? { parentId: ref.threadCommentId } : {}),
        body: text,
      });
      return JSON.stringify({ success: result.success, commentId: result.commentId });
    },
  });
}
```

Use `accessToken` instead of `apiKey` when an installed OAuth application owns
the client. Do not implement token storage, refresh, or organization-to-token
resolution unless the project already owns that installation system.

The optional organization and webhook ids pin one endpoint to a fixed
integration. Omit them only when the application intentionally accepts every
organization or webhook authorized by the signing secret.

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/linear.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Configure ordinary webhooks

Create a Linear webhook with:

```txt
https://example.com/channels/linear/webhook
```

Copy its signing secret into `LINEAR_WEBHOOK_SECRET`. Select only the resource
families the application handles, typically Comments, Issues, and Projects.

Linear signs the exact raw body with HMAC-SHA256 in `Linear-Signature`.
`@flue/linear` also enforces the signed `webhookTimestamp` within one minute.
Do not put a body parser or JSON reserialization step in front of the route.

Linear treats a delivery as failed if it does not return `200` within five
seconds, then retries after one minute, one hour, and six hours. The channel
does not enforce a timer; admit durable work quickly (dispatch, then return)
and rely on idempotency rather than blocking on slow work before responding.
Returning nothing produces an empty `200`; a JSON-compatible value becomes the
response body; return a normal Hono or Fetch `Response` for explicit status
control.

The handler receives the provider-native `payload` typed by Linear's official
`@linear/sdk/webhooks` `LinearWebhookPayload` union (discriminated on `type`,
with entity events carrying `action` and `data`). Fields keep Linear's own
names and nesting; the channel does not reshape them.

The `Linear-Delivery` header is exposed for application-owned deduplication but
is not part of the signed body. Claim it in durable storage before dispatch
when duplicate admission is unacceptable.

## Configure agent sessions

Agent-session events require a Linear OAuth application configured as an app
actor. Enable the Agent session events webhook category and install the
application with the permissions required by its intended operations,
including `app:mentionable` when users should mention it.

`created` events include `agentSession` and may include Linear's formatted
`promptContext`, `previousComments`, and `guidance`. `prompted` events include
the new `agentActivity`. Linear treats a delivery as failed after five seconds
and expects a newly created session to receive an activity or external URL
update within ten seconds.

The route waits for the application handler by design. Keep dispatch admission
short. Perform the continuing agent work after durable dispatch and post
progress through `client.createAgentActivity(...)`.

## Test without Linear

Create original synthetic JSON values from Linear's current webhook schema.
Sign the exact bytes locally and cover:

- valid and invalid HMAC signatures;
- stale and future `webhookTimestamp` values;
- fixed organization and webhook id mismatches;
- native comment, issue, project, `created`, and `prompted` payload forwarding;
- unmodeled verified resource types;
- issue-thread and agent-session conversation keys;
- handler responses and failures;
- SDK comment and agent-activity GraphQL requests against an injected fake
  Fetch transport in workerd with `nodejs_compat`;
- Node and Cloudflare project builds.

Do not contact Linear or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
