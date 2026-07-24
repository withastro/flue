# `@flue/github`

Verified GitHub webhook ingress for Flue applications.

```ts
import { createGitHubChannel } from '@flue/github';

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Path: /channels/github/webhook
  async webhook({ delivery }) {
    // `delivery.name` is the X-GitHub-Event value and narrows `delivery.payload`
    // to the native @octokit/webhooks-types event.
    if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
      await handleComment(delivery.payload);
    }
  },
});
```

Place this export in `channels/github.ts`. Flue discovers it and serves
`POST /channels/github/webhook` relative to the `flue()` mount.

The package verifies exact request bytes before parsing and acknowledges GitHub
`ping` internally. Ingress is JSON-only. Every verified non-ping delivery is
forwarded with its native `@octokit/webhooks-types` payload, discriminated by
`delivery.name`; choosing which events to act on is application policy
(subscribe to them in GitHub, branch in the handler). Returning nothing produces
an empty `200`; JSON values and ordinary Hono responses are also supported.

This package does not include an outbound GitHub client or model tools. Run
`flue add channel github` to generate editable project code using the official
`@octokit/rest` SDK and application-owned `defineTool(...)` values.

Instance ids are stable issue or pull-request identifiers, not
authorization capabilities. The package is stateless and does not deduplicate
delivery ids: GitHub expects a `2xx` within ten seconds and does not auto-retry,
so admit durable work quickly and deduplicate on `delivery.deliveryId` when it
matters.
