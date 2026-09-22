---
'@flue/react': patch
---

Keep `useFlueAgent`'s `status` at `streaming` after a reload for an unsettled submission. The reducer now derives active (unsettled) submission ids from the observed conversation — message `submissionId`s minus settled ids — instead of relying only on the in-memory admission receipt, which does not survive a reload. Previously a fresh hook would report `idle` for an admitted-but-silent prompt or a running tool call until the next assistant text part streamed.
