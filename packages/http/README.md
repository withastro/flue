# @flue/http

Generic HTTP webhook ingress channel for the Flue agent framework.

Allows receiving any arbitrary third-party webhook payload by providing custom verification and payload-to-conversation mapping.

## Installation

```bash
pnpm add @flue/http
```

## Usage

```ts
import { createHttpChannel } from '@flue/http';

export const httpChannel = createHttpChannel({
  // Optional verification check (headers + raw body string + raw body bytes)
  async verify(headers, body, rawBody) {
    const signature = headers.get('x-custom-signature');
    if (!signature) {
      // Override the default 401 response with a custom status and body:
      return Response.json({ error: 'Missing signature' }, { status: 400 });
    }
    const expected = computeSignature(rawBody); // compute over exact bytes
    return signature === expected;
  },
  // Process the validated event
  async webhook({ c, body, rawBody, json }) {
    console.log('Received payload:', json);
    return { status: 'ok' };
  },
});
```
