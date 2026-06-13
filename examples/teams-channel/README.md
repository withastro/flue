# Microsoft Teams channel example

Example of authenticated Bot Connector activities at
`/channels/teams/activities`, fixed application and tenant identity, explicit
dispatch routing, canonical conversation identity, and one project-owned Fetch
client for outbound messages.

`TEAMS_APP_ID`, `TEAMS_TENANT_ID`, and `TEAMS_APP_PASSWORD` are required when
the built application starts. Builds and type checks do not require live
credentials.

Microsoft's current JavaScript Agents and Teams SDKs require Node and use
Node-oriented authentication and hosting packages. This example instead uses
the documented OAuth client-credentials and Bot Connector REST protocols
through Fetch so the same project code executes on Node and Cloudflare Workers.
`TEAMS_OPENID_METADATA_URL`, `TEAMS_TOKEN_ISSUER`, and
`TEAMS_OAUTH_AUTHORITY` can override public-cloud endpoints for a supported
sovereign cloud.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because imported bindings are read only inside the activity
callback and agent initializer, after module evaluation.

Conversation keys include a verified Bot Connector service URL so the example
can remain stateless. They validate syntax, not authorization. The agent is
intentionally dispatch-only; any direct route must independently authorize the
caller-selected instance id before using it for outbound requests.

The package does not deduplicate activity ids. Claim them in application-owned
durable storage when duplicate dispatch admission is unacceptable. A public
HTTPS endpoint and a configured Azure Bot messaging endpoint are required for
real Teams delivery.
