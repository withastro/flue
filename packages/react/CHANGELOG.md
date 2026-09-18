# @flue/react

## 2.1.0-next.1

### Patch Changes

- Updated dependencies [11e1323]
  - @flue/sdk@2.1.0-next.1

## 2.1.0-next.0

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

- Updated dependencies [4def7b6]
- Updated dependencies [12464d7]
  - @flue/sdk@2.1.0-next.0

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
