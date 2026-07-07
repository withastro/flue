# @flue/a2a — Agent-to-Agent Protocol Channel

A Flue channel adapter that makes any Flue agent speak the [A2A protocol](https://a2a-protocol.org/), enabling agent-to-agent communication and discovery.

## What this does

- **Agent Card**: serves `/.well-known/agent-card.json` for A2A discovery
- **message/send**: accepts A2A JSON-RPC messages and routes them to the Flue agent
- **Task lifecycle**: tracks task state (submitted → working → completed)
- **Skills**: maps Flue skills to A2A skill descriptors

## Quick Start

```typescript
import { createA2AChannel } from '@flue/a2a';

const channel = createA2AChannel({
  name: 'My Agent',
  description: 'A helpful assistant',
  port: 3000,
});

// Agent is now discoverable via A2A protocol
// GET /.well-known/agent-card.json
// POST / (message/send)
```

## A2A Protocol

The [Agent-to-Agent (A2A) protocol](https://a2a-protocol.org/latest/specification/) enables interoperability between AI agents. Key concepts:

- **Agent Cards**: JSON metadata describing an agent's capabilities, served at a well-known URL
- **message/send**: JSON-RPC method for sending messages between agents
- **Tasks**: Units of work with lifecycle states (submitted, working, completed, failed)
- **Skills**: Declared capabilities that clients can discover and invoke

## Configuration

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Agent display name |
| `description` | string | Agent description |
| `port` | number | HTTP server port (default: 3000) |
| `skills` | Skill[] | A2A skill descriptors |
| `version` | string | Agent version |
| `protocolVersion` | string | A2A protocol version (default: "1.0") |

## Testing

```bash
# Start the agent
npm start

# Discover the agent
curl http://localhost:3000/.well-known/agent-card.json

# Send a message
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"messageId":"1","role":"user","parts":[{"kind":"text","text":"Hello"}]}},"id":"1"}'
```

## License

MIT
