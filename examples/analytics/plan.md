# Analytics Agent Roadmap

## Current Focus

- Finish the postflight loop: after a station returns structured work, the company-brain role should gate it against the work order, evidence, caveats, permissions, and user intent before any final response reaches the user.
- Support one bounded "send back" correction inside the same station session when the result is incomplete, unsupported, or directionally wrong.
- Keep postflight lightweight and deterministic: accept, revise once, ask a clarifying question, or block with a clear reason.

## Later

- Post-run local workspace sync from `local_manifest` to GCS/Firestore.
- Restricted sandbox policy matching the old Claude Code command allow/deny behavior.
- Port specialized report/workflow skills as first-class station roles or tools.
- Scheduler substrate for recurring reports and workflow follow-ups.
