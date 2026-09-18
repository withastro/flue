---
'@flue/react': minor
---

`sendMessage` now passes through every send control `client.send()` accepts (`idempotencyKey`, `initialData`, `uid`, `signal`, …) and resolves with the admission receipt (`AgentSendResult`) instead of `void`.

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
