# @flue/react

## 2.2.0-next.0

### Minor Changes

- 2663e50: Support document attachments (PDFs) on user messages. `DeliveredAttachment` is now a union of image and document attachments — `{ type: 'document', data, mimeType: 'application/pdf', filename? }` — accepted on `dispatch()`, the `init()` handle, and direct HTTP prompts. `session.prompt()`, `skill()`, and `task()` gain a `documents` option alongside `images`, and `@flue/react`'s `sendMessage()` gains a `documents` option. Documents are forwarded to the model as native document content: Anthropic `document` blocks, OpenAI (and Azure OpenAI) Responses `input_file` parts, and Google `inlineData`. On other model APIs the document is replaced in model context with a text placeholder saying it was omitted. Documents are stored like images — as canonical attachments projected as `file` parts with `mediaType: 'application/pdf'` — so existing conversations and persistence adapters need no migration. The SDK also exports `DeliveredImageAttachment` and `DeliveredDocumentAttachment`.

### Patch Changes

- Updated dependencies [54cabb7, 2663e50, 3b1adfd]
  - @flue/sdk@2.2.0-next.0

## 2.1.1

### Patch Changes

- fb57977: Clarify `useFlueAgent`'s `status` contract to match the reducer's actual aggregate behavior. `status` reflects the observed conversation's activity — including submissions admitted out-of-band (webhooks, dispatches, other clients) — combined with the hook's in-memory local admission recollection. The README now documents the full precedence order (failed-local-settlement `error` → streaming text → `submitted` → active/recollected submission `streaming` → retained-failed-send `error` → `idle`) and notes that a locally-admitted submission that has not yet settled keeps `streaming` across empty or absent observations until it settles. The reload fix covers submissions already represented by conversation messages; a submission admitted but not yet materialized into a message at reload time is documented as a residual window.
- 4685436: Keep `useFlueAgent`'s `status` at `streaming` after a reload for an unsettled submission. The reducer now derives active (unsettled) submission ids from the observed conversation — message `submissionId`s minus settled ids — instead of relying only on the in-memory admission receipt, which does not survive a reload. Previously a fresh hook would report `idle` for an admitted-but-silent prompt or a running tool call until the next assistant text part streamed.
- Updated dependencies [c5a2a72, d9e2ac0]
  - @flue/sdk@2.1.1

## 2.1.0

### Minor Changes

- efe765e: `sendMessage` now passes through every send control `client.send()` accepts (`idempotencyKey`, `initialData`, `uid`, `signal`, …) and resolves with the admission receipt (`AgentSendResult`) instead of `void`.

  Retry a send safely by keeping the key and reusing it when the request's outcome is uncertain:

  ```ts
  const agent = useFlueAgent({ url });
  const key = `prompt-${crypto.randomUUID()}`; // persist before sending

  try {
    const receipt = await agent.sendMessage('hello', { idempotencyKey: key });
    // receipt.submissionId correlates with settlements; receipt.deduplicated
    // is true when this retry converged on an already-admitted send.
  } catch {
    // A network failure does not prove the server rejected the prompt —
    // retry later with the same key to converge on the original submission.
  }
  ```

### Patch Changes

- Updated dependencies [4def7b6, 11e1323, 12464d7]
  - @flue/sdk@2.1.0

## 2.0.8

### Patch Changes

- Updated dependencies [9d649bc]
  - @flue/sdk@2.0.8

## 2.0.7

### Patch Changes

- 6e62278: Fix `useFlueAgent` callbacks changing identity on every store update — they now stay stable until the underlying session changes, preventing unnecessary re-renders and stale-effect churn.
- Updated dependencies [1f6238a, ef0c89f]
  - @flue/sdk@2.0.7

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.0

### Patch Changes

- Agent authoring is rewritten: an agent is a plain exported function configured with hooks, and `defineAgent` is removed.
- The SDK and React hooks address one conversation by URL.
- `@flue/react`'s `useFlueAgent()` now exposes `refresh()`.
