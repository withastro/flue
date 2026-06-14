# @flue/twilio

Verified Twilio Programmable Messaging ingress for Flue channels.

```ts
import { createTwilioChannel } from '@flue/twilio';

export const channel = createTwilioChannel({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL!,
  destination: {
    type: 'address',
    address: process.env.TWILIO_PHONE_NUMBER!,
  },
  webhook({ payload, conversation }) {
    // Handle one verified SMS or MMS message. `payload` is the provider-native
    // verified form with Twilio's PascalCase wire names.
  },
});
```

The package owns signature validation over the configured public URL, fixed
account and destination checks, the provider-native verified form body, TwiML
acknowledgement, and canonical conversation identity. It does not rename,
narrow, or coerce Twilio's fields. Applications own credentials, outbound Fetch
clients, tools, dispatch policy, and deduplication.

See the prepared package docs or
<https://flueframework.com/docs/ecosystem/channels/twilio/>.
