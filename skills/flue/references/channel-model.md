# Channel Model

Use this when adding or reviewing any provider HTTP ingress.

## Ownership Boundary

| Concern | Owner |
| --- | --- |
| Signature verification, request authentication, protocol handshakes, parsing | Channel package |
| Route namespace under `/channels/<name>/...` | Flue |
| Provider SDK client, OAuth, tokens, outbound calls | Application |
| Agent tools, authorization policy, deduplication, business persistence | Application |

Channels are inbound HTTP integrations. They are not universal provider clients and do not replace provider SDKs.

## File And Route Rules

- Each immediate `channels/<name>.ts` file exports one named `channel`.
- Filename defines route namespace.
- Provider package defines one or more fixed non-empty suffixes.
- `/channels/<name>` itself is not an endpoint.
- `app.ts` can prefix all Flue routes but cannot relocate one channel independently.

## Handler Contract

- Callback runs only after the channel package verifies and parses the request.
- Callback receives provider-native typed data and the Hono context.
- Return nothing for empty success when appropriate.
- Return Hono/Fetch responses for explicit status, headers, or body.
- Omitted optional callbacks omit their routes.
- Provider callbacks may have deadlines; admit durable work promptly.

## Delivering To Agents

Use `dispatch(...)` for provider events that should continue an agent session.

- Choose agent and instance ID in trusted application code.
- Use provider thread, issue, ticket, channel, or message identity as the conversation boundary when appropriate.
- Conversation keys are identifiers, not authorization capabilities.
- If caller-selected IDs are exposed elsewhere, authorize before using them for provider destinations or tools.
- Dispatched provider events are agent session operations, not workflow runs.

## Retry And Secret Handling

- Channel packages are stateless and do not deduplicate.
- Providers may retry, redeliver, or reorder events.
- Claim provider delivery IDs in application storage before external effects when duplicates matter.
- Keep credentials, raw bodies, response URLs, interaction tokens, and short-lived capabilities out of model context, dispatched input, logs, and durable session history.
- Validate target runtime behavior for any provider SDK path used on Cloudflare.

