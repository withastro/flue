---
'@flue/runtime': minor
'@flue/sdk': minor
'@flue/react': minor
---

Support document attachments (PDFs) on user messages. `DeliveredAttachment` is now a union of image and document attachments — `{ type: 'document', data, mimeType: 'application/pdf', filename? }` — accepted on `dispatch()`, the `init()` handle, and direct HTTP prompts. `session.prompt()`, `skill()`, and `task()` gain a `documents` option alongside `images`, and `@flue/react`'s `sendMessage()` gains a `documents` option. Documents are forwarded to the model as native document content: Anthropic `document` blocks, OpenAI (and Azure OpenAI) Responses `input_file` parts, and Google `inlineData`. On other model APIs the document is replaced in model context with a text placeholder saying it was omitted. Documents are stored like images — as canonical attachments projected as `file` parts with `mediaType: 'application/pdf'` — so existing conversations and persistence adapters need no migration. The SDK also exports `DeliveredImageAttachment` and `DeliveredDocumentAttachment`.
