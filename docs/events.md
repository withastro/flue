# Events

Flue event streams are easiest to read in a few groups:

- **Run lifecycle:** `run_start`, `run`
- **Operation lifecycle:** `operation_start`, `operation`
- **Visible assistant output:** `text_delta`
- **Reasoning output:** `thinking_start`, `thinking_delta`, `thinking_end`
- **Tool calls:** `tool_start`, `tool_call`
- **Delegated tasks:** `task_start`, `task`
- **Other runtime signals:** `compaction_start`, `compaction`, `log`, `idle`

Use these events for common cases:

- Render visible assistant output live by appending `text_delta.text`.
- Read the result of one prompt, task, shell call, or compaction from `operation.result`.
- Read the final action invocation result from `run.result`.
- Treat `tool_call` and `task` as completion/result events for their matching `*_start` events.

`text_delta` is user-visible assistant text. `thinking_*` is the model reasoning stream when a provider exposes it. Flue does not currently expose message start/end events, so `text_delta` is the streaming text primitive.

`turn` is a lower-level summary of one model round trip inside an operation. Most integrations can ignore it.

Persisted or replayed run events may be represented as truncated wrappers when oversized event payloads are stored. SDK consumers can detect those with `event.truncated === true`.
