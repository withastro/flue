---
title: Channels
description: Connect GitHub, Slack, Discord, or a custom event source to Flue agents.
---

A channel connects a provider's incoming HTTP events to explicit Flue
`dispatch(...)` calls and gives agents narrowly scoped outbound tools.

Flue provides first-party packages for:

| Provider | Package         | Ingress                      |
| -------- | --------------- | ---------------------------- |
| GitHub   | `@flue/github`  | Webhook events               |
| Slack    | `@flue/slack`   | Events API and interactivity |
| Discord  | `@flue/discord` | HTTP interactions            |

These packages own provider-specific signature verification, request parsing,
acknowledgement behavior, clients, and tool factories. Your application still
chooses the agent, instance id, and input for every accepted event.

## Choose an integration

Use a first-party package when its supported events and fixed-credential model
fit your application:

- [GitHub setup](/docs/guide/channels/github/)
- [Slack setup](/docs/guide/channels/slack/)
- [Discord setup](/docs/guide/channels/discord/)

Use [Chat SDK](/docs/guide/chat/) when you want its cross-platform
conversation model, adapters, and chat-side state management.

Build a [custom channel](/docs/guide/build-your-own-channel/) when you need a
different provider, event surface, credential model, or protocol behavior.
Channels are ordinary application code built from Fetch, Web Crypto,
`dispatch(...)`, and `defineTool(...)`.

## Mount verified ingress

Channel routes are explicit factories mounted from `app.ts`:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { github } from './channels/github.ts';

const app = new Hono();

app.mount('/webhooks/github', github.routes.webhook());
app.route('/', flue());

export default app;
```

Mount a channel route where it receives the original, unconsumed request body.
Provider signatures cover exact bytes, so body-parsing middleware must not run
first.

Route factories return unbound-safe Fetch handlers and can be mounted beneath
an application-chosen prefix. They do not register routes automatically.

## Route accepted events

Register one handler for each provider event or interaction key:

```ts title="src/channels/github.ts"
import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const github = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  token: process.env.GITHUB_TOKEN!,
});

github.on('issues.opened', async (event) => {
  const issue = {
    owner: event.repository.owner,
    repo: event.repository.name,
    issueNumber: event.payload.issue.number,
  };

  await dispatch(assistant, {
    id: github.conversationKey(issue),
    input: {
      type: 'github.issues.opened',
      deliveryId: event.deliveryId,
      title: event.payload.issue.title,
      body: event.payload.issue.body,
    },
  });
});
```

Handlers should dispatch only the normalized fields the agent needs. Raw
provider payloads and short-lived capabilities may contain sensitive values and
should not be copied into model context, logs, or durable session history.

Every routable key has one owner. Registering a duplicate handler fails during
setup; compose fan-out explicitly inside the handler so partial failures and
acknowledgement behavior remain visible.

## Bind outbound tools

Conversation keys are stable identifiers, not authorization capabilities.
Trusted application code derives the destination and binds it into an outbound
tool:

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { github } from '../channels/github.ts';

export default createAgent(({ id }) => {
  const issue = github.parseConversationKey(id);

  return {
    tools: [github.tools.commentOnIssue(issue), github.tools.addLabels(issue)],
  };
});
```

The model chooses content such as comment text or labels. It does not choose
where credentials are sent. If the agent also has a direct HTTP route, that
route must independently authorize a caller-selected instance id before
deriving tools from it.

## Plan for acknowledgement and replay

Channel packages are stateless and do not deduplicate deliveries.

| Provider             | Failure behavior                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| GitHub               | Records failed deliveries for inspection and manual redelivery; it does not automatically retry every failure. |
| Slack Events API     | May retry failed or timed-out deliveries and supplies retry metadata.                                          |
| Slack interactivity  | Requires a prompt acknowledgement and is not a dependable retry queue.                                         |
| Discord interactions | Failures are user-visible and do not provide dependable redelivery.                                            |

A successful channel response waits for the registered handler, including
required dispatch admission. Handler deadlines cannot forcibly cancel arbitrary
user code, so a timed-out handler may still finish later. When duplicate
admission is unacceptable, claim the provider delivery id in application-owned
durable storage before dispatch.

## Run on Node or Cloudflare

The first-party packages use Fetch and Web Crypto and are tested on Node and in
workerd. They do not use target-specific state.

GitHub can deliver webhooks to a public development endpoint. Slack request URLs
and Discord interaction endpoints also need public HTTPS access; use a trusted
tunnel when testing a local server. Keep development credentials separate from
production credentials.
