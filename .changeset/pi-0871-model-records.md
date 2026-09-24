---
'@flue/runtime': patch
---

Support GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 by bumping `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` from `^0.83.0` to `^0.87.1` (Discussion #758). The three model records first ship in pi 0.87.1's provider catalogs; the bump also adapts Flue to pi's transcript context contract (introduced in 0.86.0):

- The Cloudflare Workers AI binding provider now reads tools and the system prompt from the transcript's system messages instead of `context.tools` / `context.systemPrompt`, and mirrors pi's request-tools projection for Responses models (`additional_tools` / tool_search) so added definitions stay out of the cached prompt prefix.
- The binding's Anthropic client shim exposes `client.beta.messages.create` (pi 0.87 calls the beta namespace; 0.83 used `messages.create`).
- `session.prompt` rerenders update the system prompt by replacing the transcript's leading system message (pi derives `state.systemPrompt` read-only from it).
- Tool-addition tracking drops the removed `AgentToolResult.addedToolNames` marker; additions reach the model through the transcript's `toolsAdded` system messages.
- Turn telemetry now accepts transcript system messages (`LlmSystemMessage` role) and falls back to pi's transcript readers for the prompt/tool input.