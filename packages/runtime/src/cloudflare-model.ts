// Constants shared between the resolver (`internal.ts`) and the request-path
// provider (`cloudflare/workers-ai-provider.ts`). Lives at the package root, not
// in `cloudflare/`, so `internal.ts` can import it without dragging in
// `node:async_hooks` (transitive via getCloudflareContext).

/** Pi-ai `Api` slug for the binding-backed Workers AI provider. */
export const CLOUDFLARE_AI_BINDING_API = 'cloudflare-ai-binding' as const;
export type CloudflareAIBindingApi = typeof CLOUDFLARE_AI_BINDING_API;

/** Provider name surfaced on AssistantMessage records and usage logs. */
export const CLOUDFLARE_AI_BINDING_PROVIDER = 'workers-ai' as const;
