---
title: SoW Amplitude Tracking Inventory
description: Comprehensive inventory of all Amplitude analytics events tracked by the SoW frontend app and its dependent packages.
generated: 2026-05-11
source: https://docs.google.com/document/d/1W57NmaREG29NQo37XUfjvz_XgTbv8_V52OrgGGO1kCo/edit
---

# SoW Amplitude Tracking Inventory

**Scope:** `lops-frontend/apps/sow/` and the packages it consumes:
- `packages/companion`
- `packages/communication`
- `packages/firm-knowledge-base`
- `packages/prompt-library` (types only)

**Generated:** 2026-05-11

---

## 1. Amplitude Initialization

| Where | File | Notes |
|-------|------|-------|
| Companion package (only init call) | `packages/companion/src/utils/amplitude.ts` (`initCompanionAmplitude`) | Reads `import.meta.env.VITE_AMPLITUDE_API_KEY`. Called from `useCompanionAnalytics` effect when no host-provided `trackEvent` is set. Sets `defaultTracking: false`. |
| SoW app | none | `apps/sow` itself **never** calls `amplitude.init`. The shared `@amplitude/analytics-browser` singleton is initialized via the companion package when companion mounts. All `track(...)` calls in `apps/sow/src/features/**` and in `packages/communication` / `packages/firm-knowledge-base` rely on that side-effect init. |
| SoW companion config | `apps/sow/src/features/companion/companion-provider.tsx` (`analytics: { origin: "sow" }`) | Host does NOT inject a `trackEvent`, so companion falls through to `trackCompanionEvent` → amplitude singleton. |

> **Key implication:** Events from users-and-roles, templates, and communications features will silently no-op if the companion has never mounted in the session (since the singleton is uninitialized and `trackCompanionEvent` early-returns). The raw `track()` from `@amplitude/analytics-browser` will still buffer and flush once init runs, but base properties like `origin` won't be attached.

---

## 2. App-Level Events (`apps/sow/src/**`)

### 2.1 Prompt Library (via `usePromptLibraryAnalytics`)

- **Declaration:** `apps/sow/src/features/prompt-library/prompt-library.analytics.ts`
- **Wired into:** `apps/sow/src/features/prompt-library/prompt-library.companion.config.ts`
- **Base fields on every event:** `{ origin: "sow", product, firmId?, firmName? }`

| Event Name | Trigger | Extra Params | Tracking Method |
|------------|---------|--------------|-----------------|
| `[Prompt Library] Prompts input button clicked` | Click "Prompts" button in companion input bar | — | `trackPromptsButtonClicked` |
| `[Prompt Library] Prompt library CTA clicked` | Click prompt library CTA | — | `trackPromptCTAClicked` |
| `[Prompt Library] Close button clicked` | Close dialogue button | — | `trackDialogueClosedClicked` |
| `[Prompt Library] Prompts searched` | Search box submit | `{ query }` | `trackPromptsSearched` |
| `[Prompt Library] Prompts search cleared` | Clear search | — | `trackPromptsSearchCleared` |
| `[Prompt Library] Prompt card run clicked` | Run a prompt from grid card | `{ promptId, name }` | `trackPromptRanFromGrid` |
| `[Prompt Library] Prompt modal opened` | Open prompt detail modal | `{ name }` | `trackPromptModalOpened` |
| `[Prompt Library] Prompt modal closed` | Close prompt detail modal | `{ name }` | `trackPromptModalClosed` |
| `[Prompt Library] Prompt modal run clicked` | Run from prompt modal | `{ promptId, name }` | `trackPromptModalRunClicked` |
| `[Prompt Library] Create prompt button clicked` | Open create prompt form | — | `trackCreatePromptClicked` |
| `[Prompt Library] Prompt created` | After successful create | `{ promptId, name, category, sources, mode?, visibility }` | `trackPromptCreated` |
| `[Prompt Library] Prompt duplicated` | After successful duplicate | same as above | `trackPromptDuplicated` |
| `[Prompt Library] Prompt updated` | After successful update | same as above | `trackPromptUpdated` |
| `[Prompt Library] Prompt deleted` | After successful delete | `{ name }` | `trackPromptDeleted` |
| `[Prompt Library] Prompt favorited` | Favorite a prompt | `{ name }` | `trackPromptFavorited` |
| `[Prompt Library] Prompt unfavorited` | Unfavorite a prompt | `{ name }` | `trackPromptUnfavorited` |
| `[Prompt Library] Edit button clicked` | Click edit on a prompt card | `{ name }` | `trackEditClicked` |
| `[Prompt Library] Duplicate button clicked` | Click duplicate on a card | `{ name }` | `trackDuplicateClicked` |
| `[Prompt Library] Card menu opened` | Open prompt card ⋮ menu | `{ name }` | `trackCardMenuOpened` |

### 2.2 Communications — Voice Agent / Care Management

- **Files:**
  - `apps/sow/src/features/communications/agents/components/treatment-check-in/treatment-check-in-modal.tsx` (line 57) — final `track(eventType, …)` call
  - `apps/sow/src/features/communications/agents/components/treatment-check-in/care-management-options.tsx` (lines 84-95, 135)
  - `apps/sow/src/features/communications/agents/types.ts` (line 136-139) — TS union `AgentEnrollmentUpdateEventType`

| Event Name | Trigger | Params |
|------------|---------|--------|
| `[Voice Agent] Enrolled a Plaintiff` | `updatePlaintiffSchedule` mutation succeeds; plaintiff was not active → now active | `{ firm_id, case_id, plaintiff_id }` |
| `[Voice Agent] Unenrolled a Plaintiff` | Mutation succeeds: was active → schedule no longer active | same |
| `[Voice Agent] Updated Enrollment` | Mutation succeeds: no status transition (default) | same |
| `[Voice Agent] Deactivation Feedback` | Deactivating flow form submit (`isDeactivating`) | `{ case_id, plaintiff_id, deactivation_reason, deactivation_reason_text }` |

### 2.3 Communications — Schedule Agent

- **File:** `apps/sow/src/features/communications/agents/components/schedule-agent.tsx`

| Event Name | Trigger | Params |
|------------|---------|--------|
| `click` (component: `[Comms Agents] Call or Schedule Agent Click`, status: `attempted`) | User submits the schedule/call agent form (line 369) | `{ component, status: "attempted", agent_id, agent_name, num_initial_inputs, num_fields_with_sources, num_fields }` |
| `click` (component: `[Comms Agents] Call or Schedule Agent Click`, status: `success`) | `createAgentCall` mutation succeeds (line 331) | `{ component, status: "success", agent_id, agent_name, call_id, call_status, scheduled_time, smart_retries_enabled, num_initial_inputs, num_fields_with_sources, num_fields }` |

> Note: event name is `"click"`; the discriminator is the `component` param.

### 2.4 Users & Roles

- **File:** `apps/sow/src/features/users-and-roles/users-table.tsx:27`

| Event Name | Trigger | Params |
|------------|---------|--------|
| `click` (component: `add-user-button`) | Click "Add user" button | `{ path: window.location.pathname, component: "add-user-button" }` |

### 2.5 Templates

- **File:** `apps/sow/src/features/templates/templates-list/templates-list.tsx:30`

| Event Name | Trigger | Params |
|------------|---------|--------|
| `click` (component: `add-template-button`) | Click "Add template" button | `{ path: window.location.pathname, component: "add-template-button" }` |

---

## 3. Package `@evenup/communication` (`packages/communication`)

All use raw `track("click", …)` with a `component` discriminator.

| Event Name (component) | Trigger | Params | File |
|------------------------|---------|--------|------|
| `[Comms Agent] Launch Selected Agent Button` | Click "Launch" on an agent gallery item | `{ component, agent_id, agent_name, input_suggestion_status }` | `components/agents/agent-gallery-item.tsx:79` |
| `[Comms Agent] Input Suggestions None Apply Option` | Click "None of these apply" in input suggestion step | `{ component, case_id, grouped_suggestions_count }` | `components/agents/user-defined/input-suggestion-step.tsx:57` |
| `[Comms Agent] Input Suggestions Group Option` | Select a grouped suggestion in input suggestion step | `{ component, case_id, grouped_suggestions_count, group_suggestions_index, grouped_suggestions_fields_count }` | `components/agents/user-defined/input-suggestion-step.tsx:84` |
| `[Comms Agent] Input Suggestions Source Link` | Click "Source N" link in a suggestion | `{ component, case_id }` | `components/sources-links.tsx:59` |

---

## 4. Package `@evenup/firm-knowledge-base` (`packages/firm-knowledge-base`)

All use raw `track(<event-name>, …)` from `@amplitude/analytics-browser`.

| Event Name | Trigger | Params | File |
|------------|---------|--------|------|
| `Knowledge Base Viewed` | Page mount (effect on `user.role`) | `{ role }` | `components/Content.tsx:41` |
| `Knowledge Base Upload Started` | After files selected & upload kicked off | `{ fileCount }` | `components/Content.tsx:95` |
| `Knowledge Base Preview Opened` | Click a row to preview file | `{ fileId }` | `components/Table.tsx:74` |
| `Knowledge Base Download Triggered` | Click download in a row | `{ fileId }` | `components/Table.tsx:79` |
| `Knowledge Base Sort Changed` | User toggles a column sort | `{ sortBy, sortDirection }` | `components/Table.tsx:128` |
| `Knowledge Base Search Changed` | Debounced search input commit | `{ searchLength }` | `components/toolbar/SearchInput.tsx:20` |
| `Knowledge Base Filters Applied` | Apply filter set in popover | `{ filterCount, tagCount, hasExclusionFilter }` | `components/toolbar/Filters/Filters.tsx:72` |
| `Knowledge Base Filters Cleared` | Clear all filters | same shape as above | `components/toolbar/Filters/Filters.tsx:64` |
| `Knowledge Base Tag Added` | Add tag to a file row | `{ fileId, source, tagName }` | `components/table-cells/TagsCell.tsx:162` |
| `Knowledge Base Tag Removed` | Remove tag from a file row | `{ fileId, tagName }` | `components/table-cells/TagsCell.tsx:180` |
| `Knowledge Base Delete Requested` | Click "Delete" in row menu (opens confirm modal) | `{ fileId }` | `components/table-cells/ActionsCell.tsx:88` |
| `Knowledge Base Delete Confirmed` | Confirm delete in modal | `{ fileId }` | `components/table-cells/ActionsCell.tsx:36` |

---

## 5. Package `@evenup/companion` (`packages/companion`)

Companion has its own enum-backed event registry. SoW host's `companion-provider.tsx` does **not** inject `trackEvent`, so events flow through `trackCompanionEvent` → shared amplitude singleton, with `origin: "sow"` appended.

- **Event-name declaration:** `packages/companion/src/types/analytics.ts` (`CompanionAnalyticsEventTypes`)
- **Field shape declaration:** same file (`CompanionEventFields`)
- **Dispatcher hook:** `packages/companion/src/hooks/useCompanionAnalytics.ts` — adds base fields `{ firmId, firmName, utm_campaign, utm_medium, product, companionMode, ... }`
- **Wire to Amplitude:** `packages/companion/src/utils/amplitude.ts` (`trackCompanionEvent`)

### 5.1 Companion Event Registry

| Event Name (Enum Key) | Event String | Triggered At |
|----------------------|--------------|--------------|
| `OpenedCompanionModalFloatingButton` | Opened Companion Modal with Floating Button | (declared; not wired in SoW host) |
| `AskedCommonlyAskedQuestion` | Asked Commonly Asked Question | `features/home/ExamplePrompts.tsx:30` |
| `CopiedAnswer` | Copied Answer | (legacy) |
| `CopiedAnswerWithCitations` | Copied Companion Answer with Citations | `features/thread/answer-actions/AnswerActions.tsx:181-143` |
| `CopiedAnswerWithoutCitations` | Copied Companion Answer without Citations | `features/thread/answer-actions/AnswerActions.tsx:182-143` |
| `ClickedThumbsUp` | Clicked Thumbs Up on Companion Answer | `AnswerActions.tsx:212` |
| `ClickedThumbsDown` | Clicked Thumbs Down on Companion Answer | `AnswerActions.tsx:226` |
| `SetFeedbackToNull` | Set Feedback To Null on Companion Answer | `AnswerActions.tsx:215` |
| `OpenedCompanionModalDefaultQuestion` | Opened Companion Modal with Default Question | `components/AskQuestion/CaseAskQuestion.tsx:41` |
| `OpenedCompanionModalQueryCaseFiles` | Opened Companion Modal with Query Case Files Button | `features/entry-point/EntryPoint.tsx:23` |
| `OpenedCompanionModalCustomQuery` | Opened Companion Modal with custom query | `components/AskQuestion/CaseAskQuestion.tsx:39` |
| `CustomQueryInCompanionModal` | Submitted custom query in Companion Modal | `features/panel/FirmPanelHome.tsx:69` |
| `DefaultQueryInCompanionModal` | Submitted default query in Companion Modal | (declared) |
| `AnswerLoading` | Companion Answer is loading | (declared) |
| `AnswerDisplayed` | Companion Answer is displayed | `api/useGetChat.ts:155-157`, `context/BackgroundPollerProvider.tsx:81-83` |
| `NoAnswerDisplayed` | Companion No answer is displayed | `api/useGetChat.ts:137,155-157`, `context/BackgroundPollerProvider.tsx:67,81-83` |
| `AskFollowUp` | Asked a follow-up question in Companion | `context/ActiveThreadProvider.tsx:81` |
| `SearchPastQuestions` | Companion Searched past questions | `features/sidebar/useGroupedThreads.ts:20` |
| `PastQuestionClicked` | Companion Past question is clicked | `features/sidebar/PreviousThread.tsx:30`, `features/panel/PanelHistoryView.tsx:23` |
| `ArchiveQuestionClicked` | Companion Archive question is clicked | `features/sidebar/PreviousThreadActionsMenu.tsx:22` |
| `CloseModalXButtonClicked` | Companion Modal is closed with the X button | (declared) |
| `CloseModalScreenClicked` | Companion Modal is closed when the screen is clicked | `hooks/useCloseCompanion.ts:11` |
| `ClickedFullScreen` | Made Companion full screen | (declared) |
| `ClickedMinimize` | Minimized Companion | (declared) |
| `DeselectAllTags` | Deselect All Tags in Companion | `features/input/TagSelector.tsx:60-63` |
| `SelectAllTags` | Select All Tags in Companion | `features/input/TagSelector.tsx:60-63` |
| `ConcurrentQuestionAsked` | Concurrent Question Asked in Companion | `context/ActiveThreadProvider.tsx:86` |
| `ExportThread` | Export Thread in Companion | `components/ExportPopOver.tsx:32-36` (source = thread) |
| `ExportChat` | Export Chat in Companion | `components/ExportPopOver.tsx:33-36` (source = chat) |
| `QuestionCancelled` | Companion Question Cancelled | `hooks/useCancelChat.ts:22` |
| `CreateAIDraft` | Create AI Draft in Companion | `features/thread/answer-actions/CreateAIDraftButton.tsx:56` |
| `EditNotShown` | Companion Edit Not Shown | (declared) |
| `SuggestedQueryClicked` | Companion Suggested Query Clicked | `features/panel/FirmPanelHome.tsx:61`, `features/thread/answer-artifacts/SuggestedQueries.tsx:60` |
| `MatterTableLinkClicked` | Companion Matter Table Link Clicked | `features/thread/answer-artifacts/MatterTable.tsx:314` |
| `MatterTablePageChanged` | Companion Matter Table Page Changed | `features/thread/answer-artifacts/MatterTable.tsx:169` |
| `ShowMoreCategorizedQuestions` | Companion Show More Categorized Questions | `features/home/ExamplePrompts.tsx:41` |
| `ShowLessCategorizedQuestions` | Companion Show Less Categorized Questions | `features/home/ExamplePrompts.tsx:46` |
| `FirmEntryPointQuestion` | Firm QA Entry Point Question Asked in Companion | `features/entry-point/Button.tsx:19,26`, `features/entry-point/ToggleButton.tsx:23`, `features/entry-point/FirmWideEntryPoint.tsx:30` |
| `PromptLibraryPromptsButtonClicked` | `[Prompt Library] Prompts input button clicked` | mirrors `apps/sow` analytics file |
| `PromptLibraryPromptCTAClicked` | `[Prompt Library] Prompt library CTA clicked` | same |
| `PromptLibraryCloseClicked` | `[Prompt Library] Close button clicked` | same |
| `PromptLibraryPromptsSearched` | `[Prompt Library] Prompts searched` | same |
| `PromptLibraryPromptsSearchCleared` | `[Prompt Library] Prompts search cleared` | same |
| `PromptLibraryPromptRanFromGrid` | `[Prompt Library] Prompt card run clicked` | same |
| `PromptLibraryPromptModalOpened` | `[Prompt Library] Prompt modal opened` | same |
| `PromptLibraryPromptModalClosed` | `[Prompt Library] Prompt modal closed` | same |
| `PromptLibraryPromptModalRunClicked` | `[Prompt Library] Prompt modal run clicked` | same |
| `OpenedCitation` | Companion Opened Citation | `features/thread/ChatAnswer.tsx:67` |
| `SaveToLibraryClicked` | Companion Save to Library Clicked | `features/thread/answer-actions/SavePromptButton.tsx:32` |
| `SaveToLibraryPromptSaved` | Companion Save to Library Prompt Saved | `features/thread/answer-actions/SavePromptButton.tsx:42` |
| `SubmittedFirmAnalysisRequest` | Submitted Firm Analysis Request | `features/home/FirmHome.tsx:79` |
| `PanelExpandedToFullscreen` | Companion Panel Expanded to Fullscreen | `features/thread/header/Header.tsx:38` |
| `PanelHistoryOpened` | Companion Panel History Opened | `features/thread/header/Header.tsx:50` |
| `PanelNewThreadClicked` | Companion Panel New Thread Clicked | `features/thread/header/Header.tsx:44` |
| `PanelClosed` | Companion Panel Closed | `features/thread/header/Header.tsx:55` |
| `CompanionModeSwitched` | Companion Mode Switched | `components/ModeSelector.tsx:34` |
| `MatterSelected` | Companion Matter Selected | `features/input/MatterSelector/MatterSelector.tsx:34` |
| `MatterCleared` | Companion Matter Cleared | `features/input/MatterSelector/MatterSelector.tsx:75` |
| `SourcesPopoverOpened` | Companion Sources Popover Opened | `features/input/TagButtons.tsx:101` |
| `SourcesCategoryNavigated` | Companion Sources Category Navigated | `features/input/TagButtons.tsx:84` |
| `TagToggled` | Companion Tag Toggled | `features/input/TagSelector.tsx:40` |
| `CitationOverlayOpened` | Companion Citation Overlay Opened | `features/panel/CitationOverlay.tsx:17` |

### 5.2 Companion Event Params (`CompanionEventFields`)

Declared in `packages/companion/src/types/analytics.ts`:

```typescript
interface CompanionEventFields {
  question?, mode?, query?, condensedQuery?, files?, filesCount?,
  chatId?, threadId?, labels?, plaintiffs?, count?, fileType?,
  product?, matterId?, category?, firmId?, firmName?,
  utm_campaign?, utm_medium?, name?, instructions?, page?, totalPages?,
  fileUploadId?, pageNumber?, source?,
  origin?: "wi" | "sow",
  analysisRequest?, companionMode?, targetCompanionMode?
}
```

**Augmentation logic** (`useCompanionAnalytics.ts`):
- Every event gets `{ firmId, firmName, utm_campaign, utm_medium, product, companionMode }` merged in.
- `sendQuestionAnalyticEvent` additionally appends `{ query, files?, filesCount?, plaintiffs?, labels?, mode (string name) }` from the `Question` object.
- Finally, `trackCompanionEvent` adds `{ origin: "sow" | "wi" }` based on the host's `analytics.origin` config.

---

## 6. SDK Auto-Events

These are fired by the Amplitude SDK's automatic tracking (`defaultTracking`), not by custom `track()` calls. They have **no `origin` property** — the only way to distinguish SOW from LOPS is the URL path (`page_path LIKE '/sow/%'` → SOW).

### 6.1 Page Viewed

| Event Name | Table | Discriminator | Notes |
|------------|-------|---------------|-------|
| `[Amplitude] Page Viewed` | `amplitude_pageviews` | `page_path` URL | Fires on every route navigation. Top SOW pages (30d): Matters (17k), Leads (6k), Internal Tools Firms (1.7k), Tasks (1.3k), Reports (1.1k), Contacts (1.5k), Settings/Users (1.6k), Notifications (606), Templates (410) |

### 6.2 Form Interactions

| Event Name | Table | Key Property | Notes |
|------------|-------|--------------|-------|
| `[Amplitude] Form Started` | `amplitude_events` | `[Amplitude] Form Destination` | Fires when a form gains focus. Covers matters, leads, reports, settings, custom fields. The destination URL sometimes includes filter params (e.g. `/sow/matters?filter=assignedTeam-in-...`), partially capturing filter state — but noisy. |
| `[Amplitude] Form Submitted` | `amplitude_events` | `[Amplitude] Form Destination` | Fires on form submission. Same pages as Form Started. |

> **No explicit filter-changed event exists.** Filter state is only partially observable via Form Destination URLs on the matters page.

---

## 7. Cross-Cutting Notes & Known Issues

### No Unified App-Level Init
SoW relies on the companion package to call `amplitude.init`. Events from `users-and-roles`, `templates`, and `communications` features will silently no-op if the companion has never mounted in the session.

### Two Parallel Prompt Library Event Paths
- `apps/sow/src/features/prompt-library/prompt-library.analytics.ts` calls raw `track(...)` directly.
- The companion package also has `PromptLibrary*` entries in `CompanionAnalyticsEventTypes` — dispatched via `sendAnalyticEvent` from companion code when the prompt library is invoked from inside companion.

Both routes produce the same event strings; the difference is the augmented base properties.

### The `click` Event Convention
`click` with a `component` discriminator is used by `users-table`, `templates-list`, `schedule-agent`, and all of `@evenup/communication`. **Watch for this when aggregating dashboards** — they all collapse under event name `"click"`.

### TS-Typed Event Names
`AgentEnrollmentUpdateEventType` in `apps/sow/src/features/communications/agents/types.ts` is the only place app-side events have a TS literal-union guard. Most other call sites pass raw strings.
