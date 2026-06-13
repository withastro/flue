# Multi-Platform First-Party Channels

## Status and relationship to prior work

This plan starts from the implemented channel model recorded in
`plans/2026-06-13-project-owned-channel-sdks-and-tools.md`.

The current branch already provides:

- discovered `channels/<name>.ts` modules;
- fixed provider-owned route suffixes beneath `/channels/<name>`;
- verified ingress packages for GitHub, Slack, and Discord;
- constructor-owned handlers receiving an extensible object containing the
  authentic Hono context;
- provider-specific acknowledgement and response handling;
- project-owned outbound SDK clients and application-owned tools;
- named `flue add` recipes, examples, documentation, Node tests, and workerd
  tests for the existing three providers.

This plan expands that model across the external platform adapters represented
in the Chat SDK repository at the reference commit below. It does not port Chat
SDK implementations or attempt to make Flue channel packages into full
bidirectional platform abstractions.

Publication remains outside this plan and requires a separate explicit release
request.

## Objective

Implement and validate first-party Flue channel support for these ten external
platforms:

| Platform | Flue package | Work in this plan |
| --- | --- | --- |
| GitHub | `@flue/github` | Audit and intentionally expand verified HTTP ingress where needed |
| Slack | `@flue/slack` | Audit existing surfaces and research additional signed HTTP ingress such as slash commands |
| Discord | `@flue/discord` | Audit HTTP interaction parity and document long-lived Gateway boundaries |
| Microsoft Teams | `@flue/teams` | Add a first-party channel package |
| Google Chat | `@flue/google-chat` | Add a first-party channel package |
| Linear | `@flue/linear` | Add a first-party channel package |
| Telegram | `@flue/telegram` | Add a first-party channel package |
| WhatsApp Business Cloud | `@flue/whatsapp` | Add a first-party channel package |
| Twilio Messaging | `@flue/twilio` | Add a first-party messaging channel package |
| Facebook Messenger | `@flue/messenger` | Add a first-party channel package |

For every platform, the completed product should include:

- a first-party ingress package where the provider has a stable verified HTTP
  protocol suitable for Flue channels;
- typed verified events or interactions and explicit unknown variants where
  the protocol permits useful forwarding;
- canonical conversation or destination identity helpers where a durable
  destination can be represented safely;
- a named `flue add <provider>` recipe;
- one buildable example showing a project-owned provider client and at least
  one narrow application-owned tool when an outbound operation is useful;
- a provider setup guide and package API reference;
- synthetic offline protocol tests, Node tests, and workerd tests;
- a canonical Cloudflare-compatible ingress and outbound project path for every
  provider;
- packed-package and clean-consumer validation;
- a recorded primary-source research brief, implementation log, deviations,
  and final capability audit.

The result is channel equivalence at the Flue ownership boundary: verified
provider ingress, identity, responses, and project integration guidance.
Outbound API breadth remains owned by provider SDKs and application code.

## Reference repository and clean-room boundary

The educational reference is:

```txt
/Users/fschott/Code/chat
commit 9c936f87960a968c9fa6070cd3188f68c989a7ac
dated 2026-06-09
```

The reference may be used to:

- enumerate external providers;
- learn that a broad capability or protocol surface exists;
- identify operational questions and hazards requiring independent research;
- create a high-level capability checklist for the final audit;
- compare completed behavior at the end to discover omissions.

The reference must not be used to:

- copy, translate, or mechanically derive source code;
- copy package architecture, route layouts, public types, normalized event
  models, schemas, algorithms, constants, or error behavior;
- copy README examples as implementation source;
- copy fixtures, payloads, snapshots, sample messages, test data, expected
  values, or test assertions;
- port tests one-for-one or use reference tests to drive implementation;
- preserve a reference behavior merely because it exists there.

The mandatory clean-room process for each provider is:

1. Record only a short capability and risk brief from the reference.
2. Stop consulting that provider's implementation and tests during design and
   coding.
3. Research the current official provider documentation, protocol
   specification, official SDK documentation, and official SDK source where
   necessary.
4. Design an original Flue API that follows Flue's existing channel contract.
5. Hand-author synthetic fixtures from official schemas or prose, using
   clearly distinct fake ids, text, timestamps, ordering, and optional fields.
6. Complete implementation and tests without reopening reference source or
   fixtures.
7. Use the reference only for a final independent capability-gap audit.
8. Resolve discovered gaps from primary sources, never by copying the
   reference.

Every provider implementation log must name the official sources used and
affirm that no reference implementation or fixture was copied.

## Scope boundary

### Included

- Official external platform adapters listed in the objective.
- Multiple HTTP methods and multiple provider-owned route suffixes when the
  official protocol requires them.
- Verification handshakes, signed requests, bearer-token/JWT validation,
  timestamp checks, replay-relevant metadata, exact-body handling, provider
  identity constraints, and response semantics.
- Provider-specific batching and retry metadata.
- Optional inbound surfaces whose callbacks publish routes only when enabled.
- Official provider SDKs or established maintained clients in project recipes,
  selected only when they execute on both Node and Cloudflare.
- Narrow direct `fetch` clients in project code when no suitable SDK exists.

### Excluded

- Chat SDK state adapters, shared packages, community adapters, and vendor
  adapters outside the official platform list.
- Chat SDK's `adapter-web`. It is a browser/AI SDK transport rather than an
  external provider webhook protocol. Flue already owns direct agent HTTP and
  WebSocket surfaces; any new browser transport should be planned separately.
- Copying or compatibility-layering Chat SDK APIs.
- A universal outbound provider client, universal tool collection, or universal
  channel event schema.
- OAuth installation flows, credential stores, tenant registries, app
  marketplaces, or dynamic multi-installation routing unless a provider cannot
  support a useful fixed-installation channel without them.
- Long-lived provider transports such as Slack Socket Mode, Discord Gateway,
  and Telegram polling in the initial channel packages.
- Twilio Voice. The initial `@flue/twilio` package is scoped to Messaging;
  voice should receive a separate explicit product decision.
- Live provider credentials or remote provider calls in automated tests.

## Product invariants

Every provider workstream must preserve these decisions:

1. **Ingress ownership:** Flue packages own provider request verification,
   parsing, identity checks, normalization, handshakes, and provider response
   constraints.
2. **Outbound ownership:** Applications initialize and export provider SDK
   clients. Flue packages do not wrap broad provider APIs.
3. **Tool ownership:** Applications define only the model-facing tools they
   need and bind trusted destinations in application code.
4. **Routing:** Immediate `channels/<name>.ts` files are discovered beneath the
   same `flue()` mount as agents and workflows.
5. **Namespaces:** The filename fixes `/channels/<name>`. Provider packages
   declare one or more non-empty suffixes such as `/webhook`, `/events`,
   `/interactions`, or another provider-native surface.
6. **Optional surfaces:** An omitted optional callback does not publish its
   route. Recipes show unused surfaces as commented examples rather than empty
   active handlers.
7. **Handler input:** Each callback receives one extensible object such as
   `{ c, event }`, `{ c, interaction }`, or another provider-appropriate name.
   The Hono `Context` remains intact under `c`.
8. **Responses:** Application handlers return `undefined`, a JSON-compatible
   provider response, or an ordinary Hono/Fetch `Response`. `undefined`
   becomes an empty `200` only when that provider protocol permits it.
9. **No eager callbacks:** Constructors store application handlers without
   invoking them during module evaluation.
10. **Identity:** Conversation keys are canonical identifiers, not
    authorization capabilities.
11. **Unknown inputs:** Verified but unsupported provider variants should be
    represented explicitly when forwarding them is safe and useful. Protocol
    control messages may instead be handled internally.
12. **Required targets:** Every channel package and canonical project
    integration must support both Node and Cloudflare Workers. Support must be
    demonstrated with the actual package and selected outbound client path,
    not inferred from a dependency's marketing, types, successful import, or
    successful bundle.
13. **Errors:** New Flue runtime errors follow the repository's structured
    error policy. Provider package errors follow the established package
    pattern and expose machine-testable classes or fields rather than requiring
    message matching.
14. **Project validity:** Channels do not replace the existing requirement for
    at least one agent or workflow.

Provider APIs should be internally consistent without forcing false
cross-provider uniformity. Constructor options, event names, trusted identity
inputs, required responses, and route counts may differ.

## Cloudflare compatibility baseline

Cloudflare is a required platform, not an optional target claim.

Use these current platform facts as the starting point, then verify them again
against current documentation during implementation:

- Workers provides standards-based Fetch, Web Crypto, URL, and Web Streams
  APIs suitable for most webhook verification and REST clients.
- Workers Web Crypto supports the major signing and verification algorithms
  these providers are likely to require, including HMAC, RSA, ECDSA, and
  Ed25519.
- `nodejs_compat` can expose supported Node APIs, but it may also make
  non-functional stubs importable. A successful import or bundle is therefore
  not a compatibility test.
- Google documents both client-library and direct HTTP service-account OAuth
  flows. Because direct JWT construction is security-sensitive, prefer a
  maintained cross-runtime authentication implementation when Google's own
  clients do not execute in Workers.
- Microsoft Bot Connector authentication is standards-based bearer JWT,
  OpenID/JWKS, OAuth, and HTTPS REST. If Microsoft's current JavaScript SDK is
  Node-oriented, independently validate a Workers implementation built from
  those official protocol surfaces and a proven cross-runtime JOSE library.

Initial compatibility findings on 2026-06-13:

- the current `google-auth-library` package declares a Node engine and brings
  Node-oriented authentication and transport dependencies. This does not prove
  that every operation fails in Workers, but it is not evidence of support and
  must not be selected without a complete workerd spike;
- the current `@microsoft/agents-hosting` package declares Node 20 and depends
  on packages including `@azure/msal-node`, `jsonwebtoken`, and `jwks-rsa`.
  Treat it as Node-oriented unless a complete Workers execution test proves
  otherwise;
- Microsoft's Bot Connector documentation explicitly states that no special
  SDK is required for its standard HTTPS/JSON authentication protocol;
- maintained Web-interoperable JOSE implementations exist with explicit
  Cloudflare Workers support, making JWT signing, verification, and remote
  JWKS a credible standards-based building block;
- Google recommends client libraries because service-account JWT construction
  is security-sensitive. The workstream should therefore investigate a
  maintained cross-runtime Google authentication implementation before
  considering direct JWT/OAuth code.

Primary starting points:

- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
- <https://developers.google.com/identity/protocols/oauth2/service-account>
- <https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication>
- <https://github.com/panva/jose>

## Shared implementation process

Each provider should be owned as an end-to-end workstream. The implementor is
responsible for research, design, implementation, documentation, testing, and
the final audit rather than receiving a prematurely fixed event model from this
plan.

### 1. Establish the primary-source research brief

Record:

- official protocol and security documentation;
- official event, activity, update, or payload schemas;
- official acknowledgement deadlines and retry behavior;
- official verification, signing, issuer, audience, and replay rules;
- handshakes or challenge-response behavior;
- content types and body encodings;
- batch cardinality and ordering guarantees;
- delivery, interaction, update, or activity ids;
- stable tenant, application, workspace, account, page, bot, or installation
  identity available on verified requests;
- provider capabilities that must never enter model context or durable
  dispatch input;
- official or established JavaScript SDK candidates for application-owned
  outbound behavior;
- current Node and Cloudflare compatibility evidence.

Treat official examples as protocol documentation, not copyable fixtures.

### 2. Write a threat and trust model

Before designing types, state:

- which bytes or parameters are authenticated;
- which headers and payload fields become trusted after verification;
- which identity claims require explicit configuration;
- how request age, replay, duplicate delivery, and provider retries are
  represented;
- what public URL or proxy information participates in verification;
- which short-lived response URLs, tokens, or capabilities must be redacted;
- whether key discovery, JWKS caching, or key rotation is required;
- how verification behaves when network access to a key source is unavailable.

Do not parse and dispatch before verification unless the official protocol
requires limited parsing to locate verification material and that exception is
documented.

### 3. Inventory provider HTTP surfaces

Propose the smallest useful set of route suffixes and methods.

For each surface define:

- whether it is required or optional;
- whether configuration without a callback still needs the route for a
  handshake;
- its body encoding and body limit;
- its callback input;
- its default response;
- whether a response body is mandatory;
- whether it shares verification and event normalization with another route.

Do not combine semantically distinct protocols merely to reduce route count.
Do not publish unused optional surfaces.

### 4. Propose the normalized event and identity model

Design from Flue use cases and official provider semantics:

- normalize the fields applications routinely need for dispatch and routing;
- retain a `raw: unknown` escape hatch only after verification;
- use discriminated unions for meaningful variants;
- provide an explicit unknown variant where appropriate;
- preserve provider delivery and retry identifiers;
- represent one provider delivery containing multiple events without silently
  dropping entries;
- define canonical conversation or destination identity only where it remains
  stable enough for agent-instance selection;
- keep outbound capabilities and credentials out of canonical identity.

Review the proposal before implementation when it introduces a consequential
public constraint, such as collapsing a batch, choosing one conversation
boundary among several plausible boundaries, or requiring one installation
model.

### 5. Decide constructor and response contracts

Provider constructors may accept:

- secrets, public keys, tokens, expected identity, or verification URLs;
- a provider SDK object when the official SDK is the best verifier;
- injected verification dependencies needed for deterministic tests;
- one callback per enabled protocol surface;
- provider-specific body limits and bounded deadlines.

Do not require a provider SDK merely for consistency. Prefer Web Crypto and
small package-owned protocol code when that is clearer and more portable.

Use normal Hono and Fetch responses. Add a provider-specific JSON response type
only where it improves static correctness without recreating a large provider
SDK. Validate JSON compatibility at runtime.

### 6. Spike runtime and SDK compatibility

Before building the full package:

- prove the verification strategy in Node and workerd;
- bundle the selected project-owned outbound SDK through Flue's Node and
  Cloudflare targets;
- exercise one representative outbound SDK method against an injected or fake
  Fetch transport in both Node and workerd without contacting the provider;
- identify required compatibility flags, Node built-ins, dynamic imports,
  socket assumptions, or unsupported transports;
- choose the first viable option in this order:
  1. the official SDK when it explicitly supports Workers or passes the
     complete workerd execution spike;
  2. a well-maintained community client with demonstrated Workers support;
  3. a narrow project-owned Fetch client over the provider's official REST API,
     using a proven cross-runtime authentication or signing library where
     needed;
- reject a Node-only client as the canonical recipe dependency, even if it can
  be made to type-check or bundle;
- treat `nodejs_compat` as an implementation aid, not evidence of support.
  Cloudflare documents that some Node modules are partial implementations or
  non-functional import stubs, so the representative runtime operation must
  execute successfully;
- prefer Fetch, Web Crypto, URL, Web Streams, and cross-runtime JOSE/OAuth
  building blocks over Node-specific transports and filesystem-based
  credential discovery.

Record target-specific recipe branches. Do not weaken ingress ownership because
an outbound SDK is inconvenient.

Cloudflare support is a hard phase gate. If the research ladder above produces
no defensible Workers path, stop that provider before public API finalization,
record the evidence and attempted options, and bring the blocker to the user.
Do not silently ship a Node-only provider, omit the Cloudflare example, or mark
the provider complete with a target caveat.

### 7. Implement the package

Follow the existing `packages/github`, `packages/slack`, and
`packages/discord` package shape where it expresses the shared Flue contract,
but allow provider-specific modules and internal organization.

At minimum:

- export one `create<Provider>Channel()` constructor;
- export public verified input, event, response, identity, and structured error
  types needed by consumers;
- expose structural routes consumed by discovered channel routing;
- verify before invoking application callbacks;
- normalize provider inputs once;
- enforce documented limits and deadlines;
- handle protocol control messages internally where appropriate;
- serialize default and application responses deterministically;
- avoid any dependency on `@flue/runtime` unless a true ingress requirement is
  discovered and recorded;
- depend directly on Hono for public context and handler types.

Do not extract shared cross-provider verification infrastructure until at least
two implementations demonstrate the same stable internal need. Similar-looking
Meta protocols may begin with local code; shared code is justified only when it
reduces real complexity without coupling public APIs.

### 8. Design original synthetic coverage

Build fixtures independently from official schemas and prose:

- use obviously synthetic provider ids, names, text, URLs, and timestamps;
- alter object ordering and optional fields from official examples;
- generate valid signatures, tokens, and keys locally;
- include invalid signatures, stale timestamps, wrong audiences, wrong
  application identities, malformed bodies, oversized bodies, and wrong
  content types as applicable;
- cover batches, retries, duplicates, and unknown variants when the protocol
  supports them;
- avoid broad module mocking;
- intercept outbound SDK Fetch calls at a narrow transport boundary;
- never copy reference fixtures, payloads, snapshots, or expected outputs.

Tests should assert observable package behavior through mounted Hono routes,
not private helper implementation.

### 9. Add Node and workerd validation

For every package:

- run focused Node tests through its public constructor and routes;
- run workerd tests for exact-body handling, cryptography, JWT/JWKS logic,
  form parsing, response serialization, and other claimed behavior;
- type-check and build emitted declarations;
- pack the package and compile a clean strict TypeScript consumer;
- confirm the package contains no outbound client or tool implementation;
- confirm no accidental Node-only dependency is hidden by the local workspace.

Every provider must pass its workerd gate before it is complete. If the
canonical official SDK fails, replace it with a proven cross-runtime client or
narrow Fetch implementation and test the real authentication, serialization,
and request-construction path against a fake transport. If no sound path exists,
defer the provider for user review rather than weakening the required platform
matrix.

### 10. Add the project integration

Create:

- `connectors/channel--<provider>.md`;
- `examples/<provider>-channel/`;
- `apps/docs/src/content/docs/guide/channels/<provider>.md`;
- `apps/docs/src/content/docs/api/<provider>-channel.md`;
- package README content generated or prepared through existing repository
  conventions;
- navigation, channel overview, CLI examples, and changelog updates.

The recipe and example should:

- export `channel` and a project-owned `client`;
- put an accurate `// Path: ...` comment above every handler;
- show grouped event handling where it improves the example;
- dispatch only normalized, non-sensitive input;
- define one narrow tool justified by the example;
- bind trusted destinations outside model arguments;
- distinguish ingress verification credentials from outbound credentials;
- follow existing Node or Cloudflare secret conventions;
- keep optional unused surfaces commented out;
- type-check and build without real credentials.

The guide should teach the recommended setup. The API reference should document
the package-visible ingress contract, not duplicate the provider's API
reference.

### 11. Perform provider artifact review

Before the reference-repository audit:

- inspect the package tarball and declarations;
- inspect generated recipe output through the actual `flue add` path;
- run a locally signed or authenticated request against the built example;
- exercise handshakes and mandatory response bodies;
- exercise the deferred channel-agent import cycle;
- search docs, examples, and exports for accidental outbound abstractions,
  unrestricted tools, secrets in model-visible input, and unsupported runtime
  claims.

### 12. Perform the final reference gap audit

Only after implementation and tests are complete:

1. Reopen the high-level Chat SDK adapter documentation at the pinned commit.
2. Compare broad supported capability categories with the completed Flue
   channel, recipe, and example.
3. Record missing capabilities and classify each as:
   - applicable verified HTTP ingress;
   - outbound project behavior already enabled by the recipe;
   - long-lived transport outside channel scope;
   - installation/state concern outside the fixed-installation package;
   - deliberately unsupported provider feature.
4. Validate applicable gaps against current official provider documentation.
5. Implement justified gaps from primary sources.
6. Record remaining differences explicitly.

Do not use reference implementation or test files during this audit.

## Initial provider research briefs

These briefs identify likely questions. They are not final route, type, or SDK
specifications.

### GitHub

Existing Flue support verifies webhook deliveries and normalizes a small set of
issue and pull-request events.

Research and audit:

- identify the intentional event set needed for agent-driven GitHub workflows;
- preserve a useful unknown verified delivery rather than attempting an
  exhaustive webhook registry without product value;
- verify installation, repository, organization, enterprise, and hook identity
  boundaries;
- preserve ping handling, exact-body signatures, delivery ids, replay behavior,
  and form-encoded payload support where still official;
- decide whether additional normalized events materially improve the canonical
  recipe and example.

Primary starting points:

- <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- <https://docs.github.com/en/webhooks/webhook-events-and-payloads>

### Slack

Existing Flue support covers the Events API and interactions for one configured
application and workspace.

Research and audit:

- signed slash-command requests as a likely additional optional HTTP surface;
- Events API envelopes, retries, URL verification, app/workspace identity, and
  enterprise or organization installation constraints;
- interaction variants and provider-required immediate responses;
- response URLs and interaction capabilities that must not enter durable or
  model-visible data;
- whether the fixed-workspace v1 constraint remains the right initial product
  boundary;
- Socket Mode and OAuth as explicit non-goals unless separate evidence changes
  the scope.

Primary starting points:

- <https://docs.slack.dev/authentication/verifying-requests-from-slack/>
- <https://docs.slack.dev/apis/events-api/>
- <https://docs.slack.dev/interactivity/implementing-slash-commands>

### Discord

Existing Flue support covers signed HTTP interactions and provider responses.

Research and audit:

- command, component, autocomplete, modal, and future interaction variants;
- PING/PONG, response deadlines, deferred responses, application identity, and
  sensitive interaction tokens;
- whether additional HTTP interaction types should be normalized;
- the boundary between HTTP interactions and Gateway-delivered message events;
- Cloudflare behavior of the selected project-owned REST client.

Primary starting points:

- <https://discord.com/developers/docs/interactions/overview>
- <https://discord.com/developers/docs/interactions/receiving-and-responding>

### Microsoft Teams

Teams bot ingress is based on Bot Framework activities rather than an ordinary
shared-secret webhook.

Research and audit:

- Bot Connector bearer-token validation, OpenID/JWKS discovery, issuer,
  audience, service URL, tenant, and app identity;
- message, conversation update, invoke, Adaptive Card action, and other
  activity variants useful to agents;
- response and acknowledgement behavior for ordinary and invoke activities;
- stable conversation, tenant, team, channel, chat, and reply-chain identity;
- the current Microsoft 365 Agents SDK direction versus older Bot Framework
  JavaScript packages;
- outbound SDK and Cloudflare compatibility;
- a standards-based Workers fallback using Fetch for OAuth and Bot Connector
  REST plus a proven cross-runtime JOSE implementation when Microsoft's SDKs
  remain Node-oriented.

Primary starting points:

- <https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication>
- <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/conversation-basics>
- <https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/>

### Google Chat

Google Chat supports direct interaction events and may also deliver Workspace
Events through Pub/Sub.

Research and audit:

- Google-signed bearer-token verification, issuer, audience, app URL, and
  project-number expectations for direct Chat requests;
- differences between HTTP endpoint authentication and Pub/Sub push
  authentication;
- direct messages, mentions, added-to-space events, card actions, dialogs, and
  synchronous response objects;
- whether direct interactions and Workspace Events belong in one package with
  separate optional surfaces;
- space, thread, user, and app identity;
- service-account, delegated-user, and outbound Chat API client options for
  Node and Cloudflare;
- an edge-compatible service-account JWT assertion, OAuth token exchange, and
  Chat REST path when Google's Node client libraries do not execute in
  workerd. Prefer a maintained cross-runtime auth library; implement the
  standards-based flow directly only when the security contract is small,
  auditable, and thoroughly tested.

Primary starting points:

- <https://developers.google.com/workspace/chat/receive-respond-interactions>
- <https://developers.google.com/workspace/chat/verify-requests-from-chat>
- <https://developers.google.com/workspace/events/guides/auth>

### Linear

Linear exposes ordinary webhooks and agent-specific session events with
different application semantics.

Research and audit:

- official webhook signature verification and request-age requirements;
- comment, issue, project, and other resource events useful for dispatch;
- agent session event types, acknowledgement deadlines, stop signals, prompt
  context, and session identity;
- whether webhooks and agent sessions require separate optional route surfaces;
- workspace, organization, actor, issue, comment, and agent-session identity;
- the boundary between a fixed workspace integration and OAuth installation
  state;
- use of `@linear/sdk` for outbound project behavior and any official
  verification helpers for ingress.

Primary starting points:

- <https://linear.app/developers/sdk-webhooks>
- <https://linear.app/developers/agents>
- <https://linear.app/developers/agent-session-events>

### Telegram

Telegram's Bot API webhook uses an optional secret token header rather than a
body signature.

Research and audit:

- `setWebhook` secret-token validation and the security implications of an
  equality token;
- update ids, retries, duplicate delivery, allowed update types, and response
  expectations;
- messages, edited messages, callback queries, commands, reactions, and other
  update variants useful for agents;
- chats, message threads, users, and forum topics as conversation identity;
- whether one update can safely map to one callback invocation;
- direct Bot API Fetch versus a maintained SDK for outbound project code;
- prefer direct typed Fetch when a bot SDK introduces Node-only runtime
  assumptions;
- polling as an explicit non-goal.

Primary starting point:

- <https://core.telegram.org/bots/api#setwebhook>

### WhatsApp Business Cloud

WhatsApp Cloud API uses Meta webhook verification and signed batched POST
deliveries.

Research and audit:

- GET challenge verification with a configured verify token;
- POST `X-Hub-Signature-256` verification with the Meta app secret;
- account, app, business, phone-number, and recipient identity constraints;
- messages, statuses, reactions, media, locations, contacts, and interactive
  replies;
- multiple entries, changes, and messages in one delivery;
- response deadline and retry behavior;
- direct Graph API Fetch or an established client for outbound project code;
- treat Graph API Fetch as the baseline Cloudflare path rather than requiring a
  Node-oriented Meta SDK.

Primary starting points:

- <https://developers.facebook.com/docs/graph-api/webhooks/getting-started>
- <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks>

### Twilio Messaging

Twilio signs requests using the configured public URL and request parameters,
and inbound messaging commonly uses form-encoded bodies and TwiML responses.

Research and audit:

- exact public URL reconstruction behind proxies and whether configuration
  should require an explicit webhook URL;
- signature handling for form parameters and any JSON webhook variants;
- inbound SMS/MMS fields, messaging-service identity, opt-out behavior, and
  media metadata;
- status callbacks as a distinct optional surface;
- empty acknowledgement versus TwiML response semantics;
- account, subaccount, messaging service, sender, recipient, and conversation
  identity;
- Cloudflare viability of the official Twilio helper library versus a small
  package-owned verifier and project-owned Fetch client;
- use direct REST Fetch for outbound messaging when the official Twilio client
  is Node-only; do not sacrifice Cloudflare support to preserve SDK symmetry;
- voice as an explicit non-goal.

Primary starting points:

- <https://www.twilio.com/docs/usage/security#validating-requests>
- <https://www.twilio.com/docs/messaging/guides/webhook-request>

### Facebook Messenger

Messenger uses Meta webhook verification and signed batched Page events.

Research and audit:

- GET challenge verification and POST app-secret signature validation;
- Page, app, recipient, sender, thread, and message identity;
- messages, quick replies, postbacks, reactions, delivery receipts, reads, and
  opt-in or referral events useful to agents;
- multiple entries and messaging events in one delivery;
- app/page subscription and installation concerns that remain outside a fixed
  channel;
- direct Graph API Fetch or a maintained client for outbound project code;
- treat Graph API Fetch as the baseline Cloudflare path rather than requiring a
  Node-oriented Meta SDK.

Primary starting points:

- <https://developers.facebook.com/docs/graph-api/webhooks/getting-started>
- <https://developers.facebook.com/docs/messenger-platform/webhooks>

## Cross-provider test contract

Every package should intentionally cover applicable behavior from this list.
Tests should be added only where the behavior is a durable public contract.

### Verification and parsing

- exact unconsumed request bytes or official parameter canonicalization;
- valid, missing, malformed, and changed signatures or tokens;
- locally generated JWTs with valid and invalid issuer, audience, expiry, key,
  and identity;
- key rotation and bounded JWKS caching where required;
- request age and replay-window rejection where specified;
- expected provider/application/tenant/workspace/account identity;
- content type, encoding, body limits, malformed payloads, and Unicode;
- GET verification handshakes and POST delivery verification;
- public URL configuration and proxy behavior where the signature depends on
  the URL.

### Event behavior

- one representative known event for every intentional normalized family;
- explicit unknown verified variants;
- grouped switch cases in consumer code;
- batches with zero, one, and multiple applicable entries;
- retry and delivery metadata;
- duplicate ids forwarded without falsely claiming package deduplication;
- stable conversation-key round trips and invalid-key rejection;
- sensitive capability redaction from normalized input.

### Responses

- empty `200` defaults only where valid;
- plain JSON serialization;
- Hono `Response` passthrough and status control;
- provider-specific required response bodies;
- handshakes, challenge responses, PING/PONG, TwiML, invoke results, or card
  responses as applicable;
- thrown handlers and invalid return values;
- bounded handler deadlines where the provider imposes one.

### Routing and composition

- fixed filename-derived namespace and provider-owned suffix;
- every route has a non-empty suffix;
- multiple methods on one suffix where required;
- multiple optional surfaces and omitted-route behavior;
- wrong method and unknown suffix behavior through Flue runtime routing;
- root and prefixed `flue()` mounts;
- no authored `app.ts` requirement;
- channel-agent ESM cycles evaluated only through deferred callbacks.

### Target and artifact behavior

- Node build, types, and tests;
- workerd cryptography, parsing, route execution, and responses;
- actual outbound client import and one fake-transport operation in both Node
  and workerd;
- no acceptance based only on a successful Cloudflare bundle;
- explicit exercise of required authentication or request-signing logic in
  workerd;
- documented compatibility date and flags used by the test;
- clean packed-package TypeScript consumer;
- generated recipe registry behavior;
- example Node and Cloudflare builds for every provider;
- no provider network access in tests.

## Shared repository work

In addition to per-provider packages:

1. Expand the channel overview table and navigation for all supported
   providers.
2. Add named connector recipes and regenerate the connector registry.
3. Add focused `flue add` tests for every new recipe and alias.
4. Choose one canonical slug per provider. Use `google-chat` as the initial
   public proposal; record and review any naming deviation before package
   publication.
5. Add examples using the repository's existing `<provider>-channel` naming.
6. Update Knip entry patterns and workspace validation only where new
   discovered example modules require it.
7. Update release preparation so every public package's prepared docs and
   tarball are generated from canonical sources.
8. Keep the generic channel recipe provider-neutral and update it only when a
   cross-provider lesson improves unsupported-provider implementation.
9. Search for stale claims that only GitHub, Slack, and Discord are supported.
10. Keep packages independently releasable and avoid a shared runtime package
    unless repeated implementation evidence justifies one.

## Parallel ownership and commits

Provider research and implementation may proceed independently after the shared
contract is confirmed. Each workstream should own disjoint package, example,
recipe, guide, and API-reference files.

Commit work at coherent, reviewable points. A completed provider will often be
a natural commit boundary, but the implementor may split or combine work when
shared research, infrastructure, documentation, or validation makes another
history clearer. Before committing, inspect the worktree and stage only the
intended provider or shared changes; never absorb unrelated user edits to
satisfy a preferred boundary.

## Consequential decisions and deferrals

Implementors should proceed autonomously on ordinary provider-specific details.
Defer for user review only when evidence leaves multiple materially different
product directions, including:

- a provider cannot support a useful fixed-installation channel without
  Flue-owned OAuth or installation storage;
- Cloudflare support would require a Node-only runtime, remote proxy, or a
  substantial compatibility layer after official, community, and
  standards-based Fetch paths have been investigated;
- an official protocol depends on a long-lived socket or polling transport and
  no equivalent verified HTTP ingress exists;
- a batch can plausibly map to either one callback or many callbacks with
  materially different acknowledgement, ordering, or failure semantics;
- choosing conversation identity would irreversibly collapse distinct provider
  destinations;
- signature verification requires trusting proxy headers or reconstructed URLs
  without a defensible configuration contract;
- provider response deadlines conflict with Flue dispatch or handler behavior;
- a public package name or route suffix would create a likely long-term naming
  mistake;
- official documentation and official SDK behavior materially disagree.

When a consequential decision can be deferred without blocking unrelated work:

1. record the evidence and alternatives;
2. implement no accidental public commitment;
3. continue other provider workstreams;
4. leave a concrete review question in the implementation log.

## Deviations

This plan is directional, not immutable. Implementors may deviate when genuinely
new evidence from official provider sources, the codebase, target-runtime
testing, or review shows that another approach better satisfies the product
invariants.

Record every material deviation with:

- the planned assumption;
- the new evidence;
- alternatives considered;
- the chosen direction and reasoning;
- public API, documentation, test, and target impact;
- whether user review is still required.

Do not use deviation permission for unrecorded feature expansion, copying the
reference repository, or unrelated refactors.

## Implementation log

### GitHub — 2026-06-13

Status:

- Complete.

Reference capability brief:

- The high-level adapter documentation describes issue and pull-request
  conversation comments, inline pull-request review comments, mentions, and
  broad outbound message operations.
- No reference implementation, architecture, types, fixtures, payloads,
  snapshots, or tests were consulted.

Primary sources:

- GitHub webhook signature validation documentation.
- GitHub webhook best practices and ten-second response requirement.
- GitHub webhook event and payload documentation.
- Official `@octokit/webhooks-types` declarations for current required payload
  fields.
- Official Octokit REST declarations and package metadata.

Clean-room affirmation:

- All normalized types, synthetic payloads, fake ids, assertions, and tests
  were designed from GitHub's official documentation and Flue's existing
  channel contract. Nothing was copied or translated from Chat SDK source or
  tests.

Decisions:

- Keep one `POST /webhook` surface and the existing fixed-webhook constructor.
- Add `pull_request_review_comment.created` as the missing message-like inbound
  family.
- Add typed sender information and enough issue, pull-request, and comment
  context to implement mention-driven dispatch without reading `raw`.
- Keep inline review comments in the containing pull request's existing
  canonical Flue conversation identity. Expose the top-level review-comment id
  so applications that need inline replies can bind that capability
  explicitly.
- Add a default and maximum nine-second application handler deadline, leaving
  one second before GitHub's documented ten-second connection deadline.
- Continue accepting both official JSON and form-encoded webhook payloads.
- Keep Octokit as the project-owned outbound client. Its typed
  `issues.createComment()` path executes in workerd through Fetch without
  `nodejs_compat`.

Tests:

- Existing exact-byte HMAC, malformed input, response, identity, and workerd
  coverage retained.
- Added original synthetic issue-comment and pull-request-review-comment
  payloads with distinct ids and text, including top-level and reply thread-id
  behavior.
- Added handler deadline coverage.
- Added a permanent workerd test for Octokit's real typed request construction
  against a fake Fetch transport.

Validation:

- Package build, strict typecheck, Node tests, and workerd tests pass.
- Example strict typecheck, workerd outbound-client test, Node build, and
  Cloudflare build pass.
- A built Node server returns an empty `200` for an original valid signed
  delivery and `401` for an invalid signature.
- Documentation check and production build pass.
- The real `flue add` CLI test suite passes.
- Prepared publish docs were regenerated.
- The packed package contains the intended runtime declarations, JavaScript,
  README, license, and prepared docs without an outbound client or tool.
- A clean strict TypeScript consumer compiles against the packed tarball and
  sees the named review-comment reference type.

Focused review:

- Reviewed the complete provider diff for verification ordering, malformed
  payload handling, normalized event narrowing, response deadlines, response
  serialization, public declarations, Cloudflare execution, and documentation.
- Replaced an awkward emitted nested-property comment with a named public
  review-comment reference and added the missing top-level thread-id contract
  test.
- No unresolved correctness findings remain.

Deviations:

- The initial brief left event expansion open. Official GitHub and high-level
  reference documentation showed that inline review comments are a distinct
  webhook family required for the intended comment-driven channel, so the
  package now normalizes that family.

Deferrals:

- None.

Final reference gap audit:

- Reopened only the pinned high-level GitHub adapter README and capability
  matrix after implementation; no reference source or test files were used.
- Issue and pull-request conversation comments and inline review comments are
  represented as verified ingress.
- Flue deliberately keeps one canonical conversation identity at the
  containing issue or pull request rather than creating a separate agent
  identity for each inline review-comment thread. The normalized top-level
  review-comment id still enables application-owned inline replies.
- Mention detection and response policy remain application behavior over the
  normalized sender and comment fields.
- Posting, editing, deleting, reactions, history, enterprise API endpoints, and
  other broad outbound capabilities remain available through the
  project-owned Octokit client rather than a Flue abstraction.
- PAT and GitHub App credential selection, installation-client caching,
  multi-tenant installation lookup, OAuth, and durable installation state are
  outside this fixed-installation ingress package. Signed payload installation
  ids are exposed for applications that need them.
- No justified ingress gap remains.

### Slack — 2026-06-13

Status:

- Complete.

Reference capability brief:

- The high-level adapter documentation describes Events API messages and
  mentions, slash commands, Block Kit interactions, shortcuts, modals,
  single-workspace and multi-workspace OAuth modes, Socket Mode, and broad Web
  API operations.
- No reference implementation, architecture, types, fixtures, payloads,
  snapshots, or tests were consulted.

Primary sources:

- Slack request-signature verification documentation.
- Slack Events API envelope, retry, authorization, and acknowledgement
  documentation.
- Slack `url_verification` event reference.
- Slack slash-command implementation and payload documentation.
- Slack interaction acknowledgement and payload references for block actions,
  views, shortcuts, and block suggestions.
- Official `@slack/web-api` v8 release-candidate declarations, package source,
  and npm metadata.

Clean-room affirmation:

- All normalized types, synthetic forms and JSON payloads, fake ids, assertions,
  and tests were designed from Slack's official documentation and Flue's
  existing channel contract. Nothing was copied or translated from Chat SDK
  source or tests.

Decisions:

- Keep the fixed-application, fixed-workspace v1 boundary and explicitly reject
  org-wide installations. OAuth installation storage and Socket Mode remain
  outside the HTTP channel package.
- Add optional `POST /commands` ingress alongside the existing optional
  `/events` and `/interactions` surfaces.
- Accept Slack's signed URL-verification challenge without requiring app or
  workspace fields that Slack does not send in that payload.
- Normalize configured app identity for interaction variants that do not send
  `api_app_id`, while rejecting a mismatched id when one is present.
- Expand known interactions to message- or view-based block actions, view
  submissions and closures, global and message shortcuts, and block
  suggestions. Continue forwarding other verified variants as explicit
  unknown interactions.
- Expose `trigger_id`, `response_url`, and view response URLs under an explicit
  short-lived `capabilities` object with a hard documentation boundary against
  dispatch, model context, logging, and persistence.
- Keep the Fetch-based official `@slack/web-api` v8 release candidate as the
  project-owned outbound client, subject to the existing real workerd
  execution gate with `nodejs_compat`.

Tests:

- Retained exact-byte HMAC, timestamp, body limit, response, retry, identity,
  event, interaction, and canonical-thread coverage.
- Added original synthetic slash-command forms, identity and org-install
  rejection, identity-free URL verification, global shortcuts without
  `api_app_id`, view-origin actions, view closures, block suggestions, and
  workerd execution of commands and shortcuts.

Validation:

- Package build, strict typecheck, Node tests, and workerd tests pass.
- Example strict typecheck, real `WebClient` workerd test, Node build, and
  Cloudflare build pass.
- A built Node server returns the documented URL-verification challenge for an
  original valid signed request without app/workspace fields and returns `401`
  for an invalid signature.
- Documentation check and production build pass.
- The real `flue add` CLI test suite passes and verifies the generated Slack
  recipe includes the optional commands route.
- Prepared publish docs were regenerated.
- The packed package contains the intended runtime declarations, JavaScript,
  README, license, and prepared docs without an outbound client or tool.
- A clean strict TypeScript consumer compiles against the packed tarball and
  narrows slash-command and expanded interaction variants.

Focused review:

- Reviewed the complete provider diff for exact-byte verification, replay
  window, identity boundaries, org-install rejection, form parsing, capability
  handling, acknowledgement deadlines, response serialization, public
  declarations, and Cloudflare execution.
- Corrected three pre-existing protocol assumptions found during review:
  URL-verification payloads do not contain app/workspace identity, shortcuts
  may omit `api_app_id`, and block actions may originate from views without
  message context.
- Aligned new active-suite test names with repository conventions.
- No unresolved correctness findings remain.

Deviations:

- None.

Deferrals:

- OAuth, installation storage, token rotation, Socket Mode, and long-lived
  transports remain outside the fixed-workspace HTTP package.

Final reference gap audit:

- Reopened only the pinned high-level Slack adapter README, capability matrix,
  and adapter registry after implementation; no reference source or test files
  were used.
- Events API messages and mentions, slash commands, block actions, external
  select suggestions, modal submissions and closures, and global/message
  shortcuts are represented as verified HTTP ingress.
- Other signed Events API and interaction variants remain available through
  explicit unknown variants instead of forcing a prematurely exhaustive event
  registry.
- Posting, editing, deleting, reactions, files, streaming, history, custom API
  endpoints, and other broad outbound capabilities remain available through
  the project-owned `WebClient` rather than a Flue abstraction.
- Token rotation and dynamic client selection remain application-owned client
  initialization concerns.
- Multi-workspace OAuth, installation storage, token encryption, org-wide
  installs, Socket Mode, and socket forwarding remain deliberately outside the
  fixed-workspace HTTP package.
- No justified fixed-workspace HTTP ingress gap remains.

### Discord — 2026-06-13

Status:

- Complete.

Reference capability brief:

- The high-level adapter documentation describes HTTP interactions for
  commands and components, Gateway delivery for ordinary messages and
  reactions, and broad outbound messaging, files, reactions, typing, and
  history operations.
- No reference implementation, architecture, types, fixtures, payloads,
  snapshots, or tests were consulted.

Primary sources:

- Discord interaction overview and receiving/responding documentation.
- Discord application-command type and autocomplete documentation.
- Discord interaction context, installation owner, locale, token lifetime,
  and response deadline documentation.
- Current `discord-api-types` declarations and generated runtime package for
  interaction payload and REST route contracts.
- Current `@discordjs/rest` 2.6.1 export map, declarations, and Fetch-based web
  implementation.

Clean-room affirmation:

- All normalized types, synthetic payloads, generated keys and signatures,
  fake ids, assertions, and tests were designed from Discord's official
  documentation, current provider declarations, and Flue's existing channel
  contract. Nothing was copied or translated from Chat SDK source or tests.

Decisions:

- Keep one `POST /interactions` surface with exact-byte Ed25519 verification,
  fixed application identity, internal PING/PONG, required provider responses,
  and the existing 2.5-second application deadline.
- Add typed autocomplete interactions and support chat-input, user, message,
  and primary-entry-point application-command data.
- Preserve component message context, command target/resolved data, modal
  resolved data, and current scalar or list modal field values without
  duplicating Discord's complete payload type system.
- Normalize invoking user, locale, interaction context, and authorizing
  installation owners. Allow `destination` to be absent when Discord does not
  supply enough channel context, and represent private-channel identity
  without implying bot-token posting authority.
- Move the interaction token under an explicit short-lived `capabilities`
  object. Keep `raw` capability-bearing and document both values out of
  dispatch input, model context, logs, and persistence.
- Preserve the existing guild channel/thread conversation-key format. Add a
  private-channel key without changing existing guild or bot-DM keys.
- Keep Gateway, ordinary messages, reactions, and long-lived transports
  outside the HTTP channel.
- Keep `@discordjs/rest` as the project-owned outbound client. Its package-root
  conditional export executes with global Fetch in workerd. Use
  `discord-api-types` as a type-only dependency in Worker-facing canonical
  code and construct the documented REST route locally.

Tests:

- Expanded original synthetic signed payloads for all application-command
  types, autocomplete, component message context, destination-free modals,
  modern scalar and list modal values, private channels, installation owners,
  locale, user identity, contradictory identity, and capability placement.
- Retained Node and workerd exact-byte Ed25519 verification, application
  identity, response, timeout, and canonical-key coverage.
- Added a real `@discordjs/rest` workerd execution test against a fake Fetch
  transport, with no successful provider request.

Validation:

- Package build, strict typecheck, Node tests, and workerd tests pass.
- Example strict typecheck, real REST-client workerd test, Node build, and
  Cloudflare build pass.
- A built Node server returns the typed response for an original valid signed
  autocomplete interaction and returns `401` for a body changed after signing.
- Documentation check and production build pass.
- The real `flue add` CLI test suite passes.
- Prepared publish docs were regenerated.
- The packed package contains the intended runtime declarations, JavaScript,
  README, license, and prepared docs without an outbound client or tool.
- A clean strict TypeScript consumer compiles against the packed tarball and
  narrows autocomplete, capabilities, optional destinations, and
  private-channel references.

Focused review:

- Reviewed the complete provider diff for exact-byte verification, identity
  consistency, optional destination semantics, command and interaction
  narrowing, capability handling, required responses, deadlines, public
  declarations, and Cloudflare execution.
- Restored the existing guild channel/thread conversation-key shape after
  finding that an intermediate simplification would have unnecessarily changed
  durable thread identities.
- No unresolved correctness findings remain.

Deviations:

- The initial example used runtime `Routes` and response-enum imports from
  `discord-api-types`. Its runtime ESM wrapper did not expose `Routes` in the
  workerd execution spike, so canonical Worker-facing code now uses type-only
  provider imports and the documented REST path string.
- The first workerd client spike installed its fake global Fetch after the SDK
  had captured Fetch during static module initialization. One request using
  the literal dummy token `discord-test-token` reached Discord and returned
  `401`; no real credential or successful remote operation was involved. The
  permanent test installs the fake before dynamically importing the SDK and
  now remains fully local.

Deferrals:

- Discord Gateway, ordinary messages and mentions, reactions, typing, presence,
  voice, and other long-lived event delivery remain outside the HTTP channel.
- OAuth installation flows, dynamic multi-installation credentials, command
  registration, interaction follow-up storage, and durable deduplication remain
  application concerns.

Final reference gap audit:

- Reopened only the pinned high-level Discord adapter README after
  implementation; no reference source or test files were used.
- Slash commands and other application commands, autocomplete, buttons and
  other components, and modal submissions are represented as verified HTTP
  ingress.
- Regular messages, mentions, reactions, and role-mention policy require
  Gateway delivery and remain deliberately outside this serverless HTTP
  channel.
- Posting, editing, deleting, files, reactions, typing, history, embeds,
  buttons, and other broad outbound capabilities remain available through the
  project-owned REST client rather than a Flue abstraction.
- No justified HTTP-interaction ingress gap remains.

### Microsoft Teams — 2026-06-13

Status:

- Complete.

Reference capability brief:

- The high-level adapter documentation describes Bot Framework activities,
  mentions, Adaptive Cards and modals, reactions, direct and group
  conversations, broad outbound messaging, streaming, files, typing,
  Microsoft Graph user lookup, and message history.
- No reference implementation, architecture, types, fixtures, payloads,
  snapshots, sample messages, or tests were consulted.

Primary sources:

- Microsoft Bot Connector incoming-request authentication and endorsement
  documentation.
- Microsoft Bot Connector send-and-receive REST documentation.
- Microsoft Teams bot conversation and activity documentation.
- Microsoft Teams resource-specific consent and message-delivery
  documentation.
- Microsoft 365 Agents SDK authentication documentation.
- Official `@microsoft/agents-hosting`, `@microsoft/teams.apps`, and
  `@microsoft/agents-activity` package metadata and declarations.
- Microsoft public-cloud OpenID metadata and endorsed JWKS document.
- `jose` package exports and Web API runtime declarations.

Clean-room affirmation:

- All normalized activity types, synthetic payloads, generated RSA keys and
  JWTs, fake ids, assertions, OAuth responses, and Connector requests were
  designed from Microsoft primary sources and Flue's existing channel
  contract. Nothing was copied or translated from Chat SDK source, types,
  fixtures, payloads, snapshots, sample messages, or tests.

Decisions:

- Add `@flue/teams` and `flue add teams` with one
  `POST /channels/<file>/activities` surface.
- Keep a fixed-application, fixed-host-tenant v1 boundary. Bot Connector JWT
  audience constrains the application; authenticated conversation and channel
  tenant fields constrain the Teams tenant. Sender account tenant ids are not
  forced to match because guest and shared-channel users may belong to another
  tenant.
- Verify `RS256` Bot Connector tokens through configurable OpenID metadata,
  require the configured issuer and audience plus expiration, require the
  selected signing key's `msteams` endorsement, and compare the activity
  `serviceUrl` exactly with the signed `serviceurl` claim.
- Cache bounded OpenID/JWKS results and imported Web Crypto keys. Refresh once
  for an unknown key id with a cooldown that prevents unbounded attacker-driven
  discovery requests.
- Normalize message, conversation-update, invoke, and message-reaction
  activities. Preserve other authenticated activity types as explicit unknown
  variants.
- Expose Teams account, mention, conversation, team, channel, thread, bot, and
  verified Connector service identities needed for dispatch and outbound
  routing.
- Keep normal Hono and Fetch response behavior: `undefined` becomes an empty
  `200`, JSON-compatible values become JSON responses, and `Response` values
  pass through. Use a default and maximum 4.5-second application deadline so
  invoke handlers complete before Teams' documented five-second response
  window.
- Do not use Microsoft's current JavaScript hosting SDKs in the canonical
  recipe. `@microsoft/agents-hosting` and `@microsoft/teams.apps` declare Node
  runtimes and depend on Node-oriented MSAL, JWT, HTTP, or Express stacks.
- Provide a project-owned Fetch client that performs tenant-specific OAuth
  client credentials and Bot Connector REST message requests. The client is
  application code, not an outbound abstraction exported by `@flue/teams`.
- Retain the verified Connector `serviceUrl` and bot id in the conversation
  reference so the canonical example remains stateless. Conversation keys
  remain syntax-only identifiers and the example agent remains dispatch-only.
- Support public-cloud defaults plus explicit OpenID metadata, issuer, and
  OAuth-authority overrides for a supported sovereign deployment.

Tests:

- Added original synthetic activities with distinct application, tenant,
  conversation, team, channel, thread, user, and bot ids.
- Generated RSA keys and signed Bot Connector JWTs locally for valid,
  malformed, expired, wrong-audience, unknown-key, rotated-key, unendorsed,
  service-URL mismatch, channel mismatch, and tenant mismatch coverage.
- Covered messages and mentions, attachments, invokes, conversation updates,
  reactions, unknown variants, external-user tenant identity, response
  serialization, Hono status control, handler failure and timeout, body limits,
  media types, discovery failure, and canonical-key round trips.
- Added permanent workerd execution of `jose` RSA/JWT/JWKS verification.
- Added permanent workerd execution of the project-owned OAuth and Connector
  Fetch client against an injected local transport, including token reuse and
  exact request construction.

Validation:

- Package build, strict typecheck, Node tests, and workerd tests pass.
- Example strict typecheck, workerd outbound-client test, Node build, and
  Cloudflare build pass. Both builds discover exactly one `teams` channel.
- A built Node server returned empty `200` for an original locally signed
  authenticated activity and `401` for an invalid bearer token while using a
  local HTTPS OpenID/JWKS server.
- Documentation check and production build pass.
- The real `flue add` CLI test suite passes and verifies the Teams recipe and
  Workers-compatible Fetch path.
- Prepared publish docs were generated for all public packages.
- The packed package contains the intended runtime declarations, JavaScript,
  README, license metadata, and prepared docs without an outbound client or
  model tool.
- A clean strict TypeScript consumer compiles against the packed tarball and
  narrows Teams activity variants and conversation references.

Focused review:

- Reviewed the complete provider diff for JWT verification ordering, issuer
  and audience checks, key endorsements, exact service URL trust, tenant
  boundaries, key rotation, discovery failure, activity narrowing, response
  behavior, canonical identity, outbound token handling, Cloudflare execution,
  declarations, and documentation.
- Corrected the initial tenant check so an authenticated guest or
  shared-channel sender may have an account tenant different from the fixed
  host conversation tenant.
- Increased only the trusted discovery-document limit from 1 MiB to 4 MiB
  after the live Microsoft public JWKS measured approximately 967 KB. The
  activity body limit remains 1 MiB.
- Moved the project-owned Fetch helper out of the immediate `channels/`
  directory after real builds correctly discovered every file there as a
  channel module.
- Added imported-key caching and an unknown-key refresh cooldown after
  reviewing the cost and denial-of-service implications of Microsoft's large
  JWKS.
- No unresolved correctness findings remain.

Deviations:

- The initial brief preferred an official or established outbound SDK when
  possible. Current official JavaScript packages are explicitly Node-oriented
  and failed the required runtime-dependency audit, while Microsoft documents
  a small standards-based OAuth and Connector REST path. The canonical recipe
  therefore uses project-owned Fetch code on both Node and Cloudflare.
- The initial generic discovery limit matched the 1 MiB activity body limit.
  Current primary-source evidence showed that Microsoft key discovery already
  approaches that size, so discovery uses a separate 4 MiB cap.

Deferrals:

- Multi-tenant application installation, OAuth consent, credential selection,
  token encryption, and durable installation state remain outside this
  fixed-tenant channel.
- Federated workload identity is an application-owned alternative token source;
  the canonical cross-platform recipe uses a client secret.
- Microsoft Graph user lookup, message history, channel enumeration, and their
  delegated, application, or resource-specific permissions remain
  application-owned outbound behavior.
- Editing and deleting messages, file uploads, typing, streaming, Adaptive Card
  construction, proactive conversation creation, and other broad outbound
  behavior remain additions to the project-owned client rather than Flue
  package API.
- No live Teams tenant, Azure Bot registration, or provider credential was used
  in automated or manual validation.

Final reference gap audit:

- Reopened only the pinned high-level Teams adapter README and root capability
  statement after implementation; no reference source, declarations, sample
  messages, or tests were used.
- Messages and mentions, conversation updates, Adaptive Card or modal invokes,
  and received reactions are represented as authenticated HTTP ingress.
- Buttons, cards, and modals are invoke payload and response policy over the
  normalized activity rather than separate Flue route surfaces.
- Direct messages, group chats, channels, and channel threads are represented
  in the normalized destination model.
- Receiving all channel or group-chat messages is Teams application
  registration and resource-specific consent configuration, documented in the
  guide rather than package behavior.
- Posting is demonstrated by the project-owned Fetch client. Editing, deleting,
  files, typing, streaming, history, Graph user lookup, channel lookup, and
  other broad outbound capabilities remain application behavior.
- Multi-tenant and federated credential modes remain application installation
  and token-source concerns outside the fixed-tenant HTTP ingress package.
- No justified authenticated HTTP ingress gap remains.

## Implementation log template

Append one section per provider while implementing:

```md
### <Provider> — YYYY-MM-DD

Status:

- Research / design / implementation / docs / audit / complete

Reference capability brief:

- High-level capabilities observed without consulting implementation or tests

Primary sources:

- Official protocol docs
- Official security docs
- Official SDK docs/source

Clean-room affirmation:

- No source, types, fixtures, payloads, snapshots, or tests copied or translated

Decisions:

- Package and recipe name
- Routes and optional surfaces
- Constructor inputs
- Event and identity model
- Response behavior
- Outbound SDK/client recommendation
- Node and Cloudflare support

Tests:

- Synthetic fixture origin and how it differs from official examples
- Node coverage
- workerd coverage
- example fake-transport coverage
- signed built-example smoke result

Deviations:

- Evidence, alternatives, choice, and impact

Deferrals:

- Consequential unresolved question and why unrelated work can continue

Final reference gap audit:

- Applicable gaps resolved from primary sources
- Deliberate non-goals and remaining differences
```

## Validation

Run focused validation during each provider workstream, then the complete
repository gates in dependency order.

Per package, adapt:

```sh
pnpm --filter @flue/<provider> run build
pnpm --filter @flue/<provider> run check:types
pnpm --filter @flue/<provider> run test
pnpm --filter @flue/<provider> run test:workerd
```

Per example, adapt:

```sh
pnpm --filter <provider>-channel-example run check:types
pnpm --filter <provider>-channel-example run build
pnpm --filter <provider>-channel-example run test:workerd
```

Shared gates:

```sh
pnpm --dir packages/runtime run build
pnpm --dir packages/runtime run check:types
pnpm --dir packages/runtime run test

pnpm --dir packages/cli run build
pnpm --dir packages/cli run check:types
pnpm --dir packages/cli run test

pnpm --dir apps/docs run check
pnpm --dir apps/docs run build

pnpm run check
git diff --check
```

Also:

- run `scripts/prepare-publish.mjs`;
- pack every channel package and inspect its contents;
- compile clean strict consumers from packed artifacts;
- exercise every named recipe through the real `flue add` output path;
- send synthetic valid and invalid requests to every built example without
  contacting a provider;
- execute one representative outbound request-construction and authentication
  path for every example in workerd against a fake Fetch endpoint;
- run scoped stale-claim and secret/capability searches;
- perform one focused review of the completed cross-provider work and
  independently evaluate each concrete finding.

## Completion criteria

This plan is complete when:

- all ten external providers have an intentional Flue channel outcome;
- the seven net-new packages are implemented unless primary-source research
  produces a recorded consequential blocker;
- GitHub, Slack, and Discord are audited and expanded where applicable;
- every supported HTTP surface verifies requests before application behavior;
- provider identity, batching, retries, handshakes, and mandatory responses are
  represented correctly;
- every package follows the established discovered-channel and Hono handler
  contract without unnecessary cross-provider abstraction;
- project-owned outbound clients and application-owned tools remain the only
  outbound model;
- named `flue add` recipes, examples, guides, API references, navigation, and
  changelog entries exist for every supported provider;
- all fixtures and tests are original, synthetic, offline, and derived from
  primary provider specifications rather than the reference repository;
- Node and Cloudflare behavior are exercised for every completed provider;
- Cloudflare is supported for every completed provider; no canonical recipe
  depends on a Node-only client;
- official SDKs that fail the workerd execution gate are replaced by proven
  cross-runtime clients or narrow standards-based Fetch implementations;
- package tarballs and clean consumers contain only the intended public
  contract;
- the final pinned-reference gap audit is recorded for every provider;
- deviations and unresolved consequential decisions are explicit;
- repository-wide validation and focused review pass;
- no live provider API or credential is required for automated validation.
