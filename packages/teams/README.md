# `@flue/teams`

Authenticated Microsoft Teams Bot Connector activity ingress for Flue
applications.

```ts
import { createTeamsChannel } from '@flue/teams';

export const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  tenantId: process.env.TEAMS_TENANT_ID!,

  // Path: /channels/teams/activities
  async activities({ activity }) {
    await handleActivity(activity);
  },
});
```

Place this export in `channels/teams.ts`. Flue discovers it and serves
`POST /channels/teams/activities` relative to the `flue()` mount.

The package validates Bot Connector bearer tokens through Microsoft's OpenID
metadata and endorsed JWKS keys, checks the token audience, issuer, expiry,
channel endorsement, exact service URL, and configured tenant, then normalizes
messages, conversation updates, invokes, reactions, and unknown verified
activity types.

This package does not include an outbound Teams client, OAuth credential
storage, installation flow, or model tools. Run `flue add teams` to generate
editable project code using a narrow Fetch client over Microsoft's OAuth and
Bot Connector REST protocols.

Conversation keys identify Teams conversations and channel threads. They are
not authorization capabilities. The package is stateless and does not
deduplicate activity ids.
