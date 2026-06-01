# Amplitude Event Tracking — SOW App

Living document. Each refresh appends a log entry and audits only the delta PRs since the last entry.

---

## Refresh Log

| Date       | Audited Through PR | BQ Window   | Author  | Notes                                                 |
|------------|--------------------|-------------|---------|-------------------------------------------------------|
| 2026-05-16 | #15176             | 2026-05-11+ | bill.gu | Initial audit — code scan + BQ live data cross-check  |

**Next refresh:**
1. Check the last audited PR number above
2. `gh pr list --state merged --base main --json number,title --limit 100` — filter from the last audited PR onward
3. For each PR in range: `gh pr diff <number> | grep -E '^\+.*track\(|^\+.*amplitude'`
4. Add any new `track()` calls found to the Events by Feature section below
5. Update this log table with today's date and the new highest PR number


---

## Infrastructure

| Item | Value |
|------|-------|
| SDK | `@amplitude/analytics-browser@2.8.1` |
| API key env var | `VITE_AMPLITUDE_API_KEY` |
| Init file | `packages/companion/src/utils/amplitude.ts` |
| Init strategy | Lazy — fires on first `track()` call; no-ops if API key is absent |
| `defaultTracking` | `false` (no automatic page-view or click events) |
| User identification | Done in main webapp (`webapp/src/infrastructure/apm/amplitude.ts`); SOW rides the same global instance |

---

## Events by Feature

### 1. Prompt Library

**Analytics file:** `apps/sow/src/features/prompt-library/prompt-library.analytics.ts`
**Pattern:** Centralized hook `usePromptLibraryAnalytics(product, user)` — all 18 events go through a shared `sendEvent()` helper.

| Event Name | Extra Properties | Trigger |
|-----------|-----------------|---------|
| `[Prompt Library] Prompts input button clicked` | — | Input button opens prompt library |
| `[Prompt Library] Prompt library CTA clicked` | — | CTA inside companion |
| `[Prompt Library] Close button clicked` | — | Dialog dismissed |
| `[Prompt Library] Prompts searched` | `query` | Search input changes |
| `[Prompt Library] Prompts search cleared` | — | Search cleared |
| `[Prompt Library] Prompt card run clicked` | `promptId`, `name` | Run from grid card |
| `[Prompt Library] Prompt modal opened` | `name` | Card expanded to modal |
| `[Prompt Library] Prompt modal closed` | `name` | Modal dismissed |
| `[Prompt Library] Prompt modal run clicked` | `promptId`, `name` | Run from modal |
| `[Prompt Library] Create prompt button clicked` | — | "New prompt" button |
| `[Prompt Library] Prompt created` | `promptId`, `name`, `category`, `sources`, `mode?`, `visibility` | Prompt save confirmed |
| `[Prompt Library] Prompt duplicated` | `promptId`, `name`, `category`, `sources`, `mode?`, `visibility` | Duplicate confirmed |
| `[Prompt Library] Prompt updated` | `promptId`, `name`, `category`, `sources`, `mode?`, `visibility` | Edit saved |
| `[Prompt Library] Prompt deleted` | `name` | Delete confirmed |
| `[Prompt Library] Prompt favorited` | `name` | Star toggled on |
| `[Prompt Library] Prompt unfavorited` | `name` | Star toggled off |
| `[Prompt Library] Edit button clicked` | `name` | Edit menu item |
| `[Prompt Library] Duplicate button clicked` | `name` | Duplicate menu item |
| `[Prompt Library] Card menu opened` | `name` | `⋯` overflow menu opened |

---

### 2. Voice Agent — Enrollment

**File:** `apps/sow/src/features/communications/agents/components/treatment-check-in/treatment-check-in-modal.tsx:57`

| Event Name | Properties | Trigger |
|-----------|-----------|---------|
| `[Voice Agent] Enrolled a Plaintiff` | `firm_id`, `case_id`, `plaintiff_id` | Plaintiff enrolled |
| `[Voice Agent] Unenrolled a Plaintiff` | `firm_id`, `case_id`, `plaintiff_id` | Plaintiff unenrolled |
| `[Voice Agent] Updated Enrollment` | `firm_id`, `case_id`, `plaintiff_id` | Enrollment settings updated |

---

### 3. Voice Agent — Deactivation

**File:** `apps/sow/src/features/communications/agents/components/treatment-check-in/care-management-options.tsx:135`

| Event Name | Properties | Trigger |
|-----------|-----------|---------|
| `[Voice Agent] Deactivation Feedback` | `case_id`, `plaintiff_id`, `deactivation_reason`, `deactivation_reason_text?` | Voice Agent deactivated |

---

### 4. Comms Agents — Call / Schedule

**File:** `apps/sow/src/features/communications/agents/components/schedule-agent.tsx:330–376`

| Event Name | `status` | Key Properties | Trigger |
|-----------|----------|---------------|---------|
| `"click"` | `"attempted"` | `component: "[Comms Agents] Call or Schedule Agent Click"`, `agent_id`, `agent_name`, `num_fields` | Form submitted |
| `"click"` | `"success"` | same + `call_id`, `call_status`, `scheduled_time`, `smart_retries_enabled` | Mutation succeeded |

---

### 5. Generic Button Clicks

| File | `component` value | Trigger |
|------|------------------|---------|
| `apps/sow/src/features/users-and-roles/users-table.tsx:27` | `"add-user-button"` | Add User button |
| `apps/sow/src/features/templates/templates-list/templates-list.tsx:30` | `"add-template-button"` | Add Template button |

---

### 6. Voice Agent — Additional (BQ-observed, source not yet located)

| Event Name | 7-day count |
|-----------|------------|
| `[Voice Agent] Viewed Calls` | 5,503 |
| `[Voice Agent] Viewed a Call` | 6,551 |
| `[Voice Agent] Played Recording` | 1,219 |
| `[Voice Agent] Downloaded Recording` | 47 |
| `[Voice Agent] Dismissed Enrollment Modal` | 49 |
| `[Voice Agent] Call Quality Feedback` | 10 |
| `[Voice Agent] Clicked Plaintiff Heads Up CTA` | 2 |

---

### 7. Comms Agent — Additional `click` Components (BQ-observed, source not yet located)

| `component` value | 7-day count |
|-------------------|------------|
| `[Comms Agent] Launch Selected Agent Button` | 2,202 |
| `[Comms Agent] Input Suggestions Group Option` | 616 |
| `[Comms Agent] Input Suggestions Source Link` | 31 |
| `[Comms Agent] Input Suggestions None Apply Option` | 26 |

---

## Known Inconsistencies (as of #15176)

| Issue | Example | Standard going forward |
|-------|---------|----------------------|
| Mixed property casing | `firm_id` vs `firmId` | snake_case |
| Generic `"click"` event name | `schedule-agent.tsx` | `[Feature] Verb Noun` format |
| Most SOW events missing `origin: "sow"` | Voice Agent, `click` events | Always include in base fields |
| `firmId` sent as integer (Companion) vs UUID (Prompt Library) | — | UUID |
