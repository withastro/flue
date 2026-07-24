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
channel endorsement, exact service URL, and configured tenant, then hands your
callback the verified provider-native Bot Framework `Activity` unchanged. Switch
on the native `activity.type` (`message`, `conversationUpdate`, `invoke`,
`messageReaction`, and other Bot Framework types), and call
`channel.destination(activity)` to derive the canonical routing identity when
you need to address a reply.

This package does not include an outbound Teams client, OAuth credential
storage, installation flow, or model tools. Run `flue add channel teams` to generate
editable project code using a narrow Fetch client over Microsoft's OAuth and
Bot Connector REST protocols.

Instance ids identify Teams conversations and channel threads. They are
not authorization capabilities. The package is stateless and does not
deduplicate activity ids.
