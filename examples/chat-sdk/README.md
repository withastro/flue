# Chat SDK with Flue

This example uses Chat SDK for GitHub issue-comment messaging while Flue owns
agent session identity, durable dispatch, agent execution, and the approval
flow.

```txt
signed GitHub issue_comment webhook
  -> ChatIngressAgent
  -> Chat SDK GitHub adapter + agents/chat-sdk state
  -> createChatSdkChannel(...)
  -> Flue dispatch(assistant, ...)
  -> Flue agent tool
  -> ChatIngressAgent delivery
  -> Chat SDK thread.post(...)
  -> fake local GitHub comment API
```

The fixture uses a scripted model provider so its end-to-end test is local and
deterministic. Chat SDK state is backed by Flue's optional
`@flue/runtime/channel/chat-sdk/cloudflare` helper, which wraps
`agents/chat-sdk`.

The test demonstrates a minimal human-in-the-loop flow:

- a mention starts a Flue agent session;
- the Chat SDK thread is subscribed;
- the agent asks for human approval;
- a non-mention follow-up comment routes through the subscribed thread;
- the same Flue session posts the approved result.

## Run on Cloudflare

```sh
node ../../packages/cli/bin/flue.mjs dev --target cloudflare --port 3585
node ./test/e2e.mjs
```
