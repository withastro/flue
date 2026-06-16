# Slack Channel

Use this for `@flue/slack`, Slack Events API, interactions, slash commands, and Web API tools.

## Setup

- Run `flue add channel slack`.
- Use `@flue/slack` for verified ingress.
- Use Slack's official `@slack/web-api` client for outbound calls.
- Required environment:
  - `SLACK_SIGNING_SECRET`
  - `SLACK_BOT_TOKEN`

## Surfaces

| Slack surface | Route |
| --- | --- |
| Event Subscriptions | `/channels/slack/events` |
| Interactivity | `/channels/slack/interactions` |
| Slash commands | `/channels/slack/commands` |

Add only the callbacks the application handles. Omitted callbacks omit routes. URL verification is answered internally after signature verification.

## Events

- `payload` is Slack's outer Events API delivery.
- For `event_callback`, `payload.event` uses Slack's event union.
- Switch on `payload.event.type`; message subtypes remain under `payload.event.subtype`.
- The channel does not filter bot messages, subtypes, or event families.
- `app_rate_limited` notifications reach the callback.
- Workspace and enterprise identity stay in payload; enforce allowlists in application code when needed.

## Interactions And Commands

- Payloads preserve Slack snake_case wire fields.
- `trigger_id`, `response_url`, and view `response_urls` are short-lived capabilities.
- Keep those capabilities in immediate trusted request handling, not model context, dispatch input, logs, or durable session history.
- Slack expects prompt acknowledgements; dispatch durable work and return quickly.

## Thread Tools

- Export a Web API `client`.
- Define tools such as `replyInThread(ref)` with channel and thread bound in trusted code.
- Use `channel.conversationKey({ teamId, channelId, threadTs })` for thread-scoped agent instances.
- The model should choose message text, not Slack destination or token.

