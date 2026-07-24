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
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and whether the application needs
ordinary issue comments, Linear agent sessions, or both.

Install `@flue/linear` and `@linear/sdk@^86.0.0`. Flue owns verified ingress.
The project owns the official SDK client and every outbound tool.

The current official SDK is used by Linear's own Cloudflare Workers agent
example with `nodejs_compat`. Flue's Cloudflare target supplies that
compatibility flag. Keep a workerd fake-transport test for every SDK operation
the project relies on.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/linear.ts`. Adapt the imported agent, dispatched
message, event policy, and tool:

```ts
// flue-blueprint: channel/linear@1
import { createLinearChannel, type LinearWebhookPayload } from '@flue/linear';
import { defineTool, dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import * as v from 'valibot';
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithCommentData,
} from '@linear/sdk/webhooks';
import { Assistant } from '../agents/assistant.ts';

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
      await dispatch(Assistant, {
        id: channel.instanceId({
          type: 'issue',
          organizationId: payload.organizationId,
          issueId: comment.issueId,
          ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
        }),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          type: 'issue',
          issueId: comment.issueId,
          ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
          ...(comment.issue?.title ? { issueTitle: comment.issue.title } : {}),
        },
        message: {
          kind: 'signal',
          type: 'linear.comment.created',
          body: comment.body,
          attributes: {
            deliveryId,
            ...(payload.actor ? { actorId: payload.actor.id } : {}),
            ...(payload.actor && 'name' in payload.actor ? { actorName: payload.actor.name } : {}),
          },
        },
      });
      return;
    }

    if (isAgentSessionEvent(payload)) {
      await dispatch(Assistant, {
        id: channel.instanceId({
          type: 'agent-session',
          organizationId: payload.organizationId,
          agentSessionId: payload.agentSession.id,
        }),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          type: 'agent-session',
          agentSessionId: payload.agentSession.id,
          ...(payload.agentSession.issue?.title
            ? { issueTitle: payload.agentSession.issue.title }
            : {}),
        },
        message: {
          kind: 'signal',
          type: `linear.agent_session.${payload.action}`,
          body: JSON.stringify({
            promptContext: payload.promptContext,
            activity: payload.agentActivity,
            session: payload.agentSession,
          }),
          attributes: { deliveryId },
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

/** The subset of `LinearConversationRef` actually needed to post a message. */
export type LinearMessageRef =
  | { type: 'agent-session'; agentSessionId: string }
  | { type: 'issue'; issueId: string; threadCommentId?: string };

export function postMessage(ref: LinearMessageRef) {
  return defineTool({
    name: 'post_linear_message',
    description: 'Post a message to the Linear conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      if (ref.type === 'agent-session') {
        const result = await client.createAgentActivity({
          agentSessionId: ref.agentSessionId,
          content: { type: 'response', body: text },
        });
        return { success: result.success };
      }

      const result = await client.createComment({
        issueId: ref.issueId,
        ...(ref.threadCommentId ? { parentId: ref.threadCommentId } : {}),
        body: text,
      });
      return {
        success: result.success,
        ...(result.commentId === undefined ? {} : { commentId: result.commentId }),
      };
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
import { channel } from './channels/linear.ts';

const app = new Hono();
app.route('/channels/linear', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/linear` mount; a different mount path shifts every
provider URL accordingly.

Use `accessToken` instead of `apiKey` when an installed OAuth application owns
the client. Do not implement token storage, refresh, or organization-to-token
resolution unless the project already owns that installation system.

The optional organization and webhook ids pin one endpoint to a fixed
integration. Omit them only when the application intentionally accepts every
organization or webhook authorized by the signing secret.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the issue or agent-session fields the tool needs — the
agent reads them with `useInitialData()` instead of parsing the instance id —
plus the issue title when the webhook includes one. Per-message facts stay on
the signal's `attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/linear.ts';

const initialDataSchema = v.variant('type', [
	v.object({
		type: v.literal('agent-session'),
		agentSessionId: v.string(),
		issueTitle: v.optional(v.string()),
	}),
	v.object({
		type: v.literal('issue'),
		issueId: v.string(),
		threadCommentId: v.optional(v.string()),
		issueTitle: v.optional(v.string()),
	}),
]);

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Linear channel dispatch.');
	useTool(postMessage(data));
	const issueTitle = data.issueTitle ? ` on "${data.issueTitle}"` : '';
	return `Reply concisely in the bound Linear conversation${issueTitle}.`;
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

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and agent function bodies.

## Configure ordinary webhooks

Create a Linear webhook pointing at the channel's mount path in `app.ts` plus
the route suffix — with the conventional
`app.route('/channels/linear', ...)` mount:

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
- issue-thread and agent-session instance ids;
- handler responses and failures;
- SDK comment and agent-activity GraphQL requests against an injected fake
  Fetch transport in workerd with `nodejs_compat`;
- the project typecheck and `vite build` for the configured target.

Do not contact Linear or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
