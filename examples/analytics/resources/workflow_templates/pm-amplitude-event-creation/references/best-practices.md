# Amplitude Best Practices — SOW App

How to add event tracking in `apps/sow/`. These patterns are derived from existing code, with fixes for known inconsistencies.

---

## Quick Reference

```
1. Find    the client-side user action that corresponds to the event (always FE, never server-side)
2. Create  apps/sow/src/features/<feature>/<feature>.analytics.ts
3. Define  event name constants (typed union)
4. Write   a useXxxAnalytics() hook with a sendEvent() helper
5. Inject  the hook at the feature entry point, not deep in child components
6. Call    track() only from the analytics hook — never directly in components
```

---

## 0. Events are always client-side

Every Amplitude event fires from the browser. There is no server-side Amplitude instrumentation — the backend uses OpenTelemetry/Prometheus (`EvenUpCounter`) for observability, which is a separate system.

When asked to add tracking for any event, **start by finding the client-side trigger**: the button click, form submission, mutation `onSuccess`, or navigation action that represents the user moment. Even when the underlying action is executed server-side (e.g. a Temporal workflow creating a task), there is always a corresponding UI action or observable state change that can be tracked from the browser.

If no obvious client-side trigger exists, ask before assuming server-side instrumentation is needed.

---

## 1. File Structure

Each feature gets exactly one analytics file. Keep tracking logic out of components.

```
apps/sow/src/features/my-feature/
├── my-feature.tsx                  # component
├── my-feature.analytics.ts         # ← all amplitude code lives here
└── my-feature.spec.tsx             # component tests
```

---

## 2. Event Naming Convention

Format: `[Feature Name] Verb Noun`

**Be verbose and specific to avoid collision.** As the event inventory grows, generic names create ambiguity. Include the context and specific action to make each event's meaning unambiguous.

```ts
// ✅ Good — specific, descriptive, unlikely to collide
"[Prompt Library] Prompt created"
"[Voice Agent] Enrolled a Plaintiff"
"[Matter] Filter applied"
"[Tasks] Task marked complete"
"[Tasks] Task status changed"

// ⚠️ Too generic — may collide with similar events
"[Tasks] Task updated"     // is it status? name? priority? reassigned?
"[Matter] Action taken"    // what action?
"[Prompt] Action"          // avoid "action" entirely

// ❌ Avoid — component names and single-word events
"click"   // with component: "add-user-button"
"view"
"action"
"triggered"
```

**Naming principle**: If two different things could plausibly have the same name, one of them is not specific enough. Err on the side of verbosity — longer event names are easier to search and less likely to collide than short generic ones.

---

## 3. Property Naming Convention

Use **snake_case** for all event properties.

```ts
// ✅
{ firm_id: "123", task_id: "abc" }

// ❌ — camelCase found in older events, avoid going forward
{ firmId: "123", taskId: "abc" }
```

---

## 4. Standard Baseline Payload

Every SOW event must include these properties. They are non-negotiable and require no PM input.

Keep the payload small — log PKs only. Everything else is derivable by joining to dim tables in BQ.

### Event properties (sent with every `track()` call)

| Property | Type | Source | Notes |
|----------|------|--------|-------|
| `origin` | `"sow"` | hardcoded | Identifies the app |
| `firm_id` | `string` (UUID) | `useAuth()` → `user.firmId` | Needed for firm-level slicing without a join |
| `matter_id` | `string \| null` | URL param or entity context | Event-specific context; `null` when not on a matter |

### User properties (PKs only — set once at session start via `amplitude.identify()`)

| Property | Type | Notes |
|----------|------|-------|
| `uid` | `string` (UUID) | PK for future `dim_sow_users` join → name, email, firm, role |
| `impersonator_id` | `string \| null` | `null` when not impersonating |

**Not necessary** `name`, `email`, `roleId`, `roleName`, or `firmName` — all derivable from uid

### Impersonation note

Do **not** suppress events during impersonation (unlike the main webapp which drops them). `impersonator_id` as a user property means it is available on every event for filtering without inflating each event payload.

---

## 5. Analytics Hook Pattern

Model after `apps/sow/src/features/prompt-library/prompt-library.analytics.ts`.

```ts
// apps/sow/src/features/my-feature/my-feature.analytics.ts
import { track } from "@amplitude/analytics-browser"

// 1. Type all event names — prevents typos, enables grep
type MyFeatureEvent =
  | "[My Feature] Widget created"
  | "[My Feature] Widget deleted"
  | "[My Feature] Filter applied"

// 2. Type all shared base properties
interface BaseFields {
  origin: "sow"
  firm_id: string | undefined
  matter_id: string | null
}

// 3. Private helper — single track() call site
function sendEvent(
  eventName: MyFeatureEvent,
  baseFields: BaseFields,
  extra?: Record<string, unknown>,
) {
  track(eventName, { ...baseFields, ...extra })
}

// 4. Public hook — components call methods, never track() directly
export function useMyFeatureAnalytics(firmId: string | undefined, matterId: string | null) {
  const baseFields: BaseFields = { origin: "sow", firm_id: firmId, matter_id: matterId }

  return {
    trackWidgetCreated: (widgetId: string) =>
      sendEvent("[My Feature] Widget created", baseFields, { widget_id: widgetId }),

    trackWidgetDeleted: (widgetId: string) =>
      sendEvent("[My Feature] Widget deleted", baseFields, { widget_id: widgetId }),
  }
}
```

---

## 6. Where to Call the Hook

Call `useXxxAnalytics()` once at the feature's top-level component. Do not call it deep inside child components.

```tsx
// ✅ — analytics initialized once at the top
function MyFeaturePage({ firmId, matterId }) {
  const analytics = useMyFeatureAnalytics(firmId, matterId)
  return <MyFeatureTable onRowDelete={(id) => analytics.trackWidgetDeleted(id)} />
}

// ❌ — hook called inside a leaf component
function MyFeatureRow({ firmId, matterId }) {
  const analytics = useMyFeatureAnalytics(firmId, matterId) // scattered, hard to audit
}
```

---

## 7. When to Fire Events

| Scenario | When to fire |
|----------|-------------|
| Button click | On user intent (click handler) |
| Mutation success | In `onSuccess` callback |
| Mutation attempt | Before `mutate()` fires — captures funnel drop-off |
| Form open/close | On mount/unmount of the modal/panel |

For funnels, always fire both "attempted" and "success" events.

---

## 8. Passing Context Properties

Prefer IDs over names — names change, IDs don't.

```ts
// ✅
{ task_id: "abc123", task_name: "Follow up with provider" }

// ❌ — name only, loses join capability
{ name: "Follow up with provider" }
```

---

## 9. Initialization

SOW does not initialize Amplitude directly. The global instance is initialized by:
- `packages/companion/src/utils/amplitude.ts` (lazy, on first `track()` call)
- `webapp/src/infrastructure/apm/amplitude.ts` (webapp init, sets user identity)

SOW imports `track` from `@amplitude/analytics-browser` and calls it directly. If `VITE_AMPLITUDE_API_KEY` is absent, events are silently no-ops.

---

## 10. Checklist Before Merging

- [ ] Analytics file is in `<feature>/<feature>.analytics.ts`
- [ ] Event names follow `[Feature] Verb Noun` format and are **specific and descriptive**
- [ ] Event name is unambiguous — unlikely to collide with other events (avoid generic verbs like "triggered", "updated", "action")
- [ ] All properties are snake_case
- [ ] Baseline fields (`origin`, `firm_id`, `matter_id`) included in base fields
- [ ] Hook called once at the feature root
- [ ] No raw `track()` calls inside `.tsx` files
- [ ] Event name type union defined and used (no bare string literals)
- [ ] Both "attempted" and "success" events added for mutation funnels
