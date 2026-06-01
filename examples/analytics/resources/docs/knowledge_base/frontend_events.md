---
aliases: [amplitude events, frontend events, lops-frontend events, page_path, amplitude_pageviews, stg_amplitude__events, amplitudeApm, trackEvent]
event_prefixes: ["[FE][XD]", "[FE][MM]", "[Value Drivers Detractors]", "[Missing Docs Check]", "[Case Care]", "[AI Playbooks]", "[Prompt Library]", "[SmartTasks]", "[Feed]", "[Exec Analytics]", "[Voice Agent]", "[Amplitude]"]
related: [workstation.md, billing_credits.md, product_truth.md]
source_repo: lops-frontend
bq_table: evenup-bi.dbt_prod.stg_amplitude__events
pageviews_table: evenup-bi.dbt_prod.amplitude_pageviews
scope: front-end-emitted events only; excludes backend events and most SDK auto-events
last_audit: 2026-04-21
ticket: DA-1269
---

# Front-End Events (lops-frontend → Amplitude)

Events emitted by the `lops-frontend` monorepo landing in `stg_amplitude__events` (`event_type` column). Monorepo has two React apps: `webapp/` (LOPS / Portal) and `apps/sow/` (SOW). Only documents non-obvious event names — self-explanatory names (`Login Success`, `Request Submitted`, etc.) are intentionally not listed.

Emission: `amplitudeApm.trackEvent()` in `webapp/src/infrastructure/apm/amplitude.ts`. Enums under `webapp/src/infrastructure/apm/events/*Events.ts` + a few feature-local `*.events.ts` (e.g. `cases/CaseCare/case-care.events.ts`). Feature hooks: `useCaseQAAnalytics`, `useCompanionAnalytics`, `useEditorAiAnalytics`, `useMirrorModeAnalytics`.

Telemetry gating (`amplitude.ts:12-26`): suppressed on localhost, in controlled envs, when permission `disableTelemetryAmplitudeEnabled` is set, or when the user is an impersonator. `[Amplitude]` auto-events come from SDK `defaultTracking: true` (`amplitude.ts:34`), not our code.

## URL → feature (for `page_path` filtering)

`page_path` exists on `[Amplitude] Page Viewed` events only (verified: 100% of pageviews, 0% of custom events). Use `dbt_prod.amplitude_pageviews.page_path` — flat string column, user + firm already joined. For non-pageview events, session-attribute by joining to the user's most recent pageview.

### Cases (LOPS)
- `/cases` — list
- `/cases/%` — overview
- `/cases/%/timeline` — Case Care timeline
- `/cases/%/timeline/note/%` | `/medical-appointment/%` | `/voice-agent-call/%` — Case Care details
- `/cases/%/medical-bills` | `/medical-bills/viewer` — Bills Summary | external viewer
- `/cases/%/missing-doc-check/%` — MDC result
- `/cases/%/ai-playbooks` | `/ai-playbooks/view/%/%` — AI Playbooks list | result
- `/cases/%/care-management/%` — care management (plaintiff)
- `/cases/%/insights` — Case Insights
- `/cases/%/medical-record-requests` — MRR tracking
- `/cases/%/activity` — activity log
- `/cases/new` | `/cases/%/edit` — create | edit

### Express Demand (XD) — customer-driven editor path inside Workstation
- `/cases/%/express-demand/%` — XD editor
- `/cases/%/express-demand/%/exhibits/%` — XD exhibit management
- `/cases/%/express-demand/templates` — Mirror Mode templates list
- `/cases/%/express-demand/templates/create-request` — create request from template
- `/cases/%/express-demand/templates/%/review` — template review

### Standard Demand (aka Expert Demand, legacy demand editor)
- `/demands` | `/demands/%` — list | wrapper
- `/demands/%/form/{plaintiff,introduction,carrier,facts,providers,pain-and-suffering,future-expenses,non-economic,income-loss,other,firm,damages,conclusion,template,missing-docs,exhibit}` — sections
- `/demands/%/files` | `/review` | `/search` | `/relevant` | `/favorite` — side tabs
- LOPS-drafted demands with 1-3 day turnaround; customer reviews. Other Workstation path alongside XD. See `workstation.md`.

### Requests
- `/requests` | `/requests/%` | `/requests/new` | `/requests/%/edit` | `/requests/%/missing-docs` | `/requests/%/revision`

### Documents
- `/documents/%` | `/documents/%/medical-summary` | `/documents/%/view-medical-chronology` | `/documents/%/exhibit-builder` | `/documents/%/exhibit-management`

### Exhibit preview (standalone pane — exclude from engagement metrics; ~90k pageviews/7d)
- `/exhibit-preview/user-exhibit/%`
- `/exhibit-preview/exhibit-builder/exhibit/%/partition/%`
- `/exhibit-preview/documents/%/exhibit/%`
- `/exhibit-preview/pdf-preview` | `/image-preview`

### Settings
- `/settings/{profile,firms,firms/%,firms/%/attorneys,accounts,billing,credits,ai-playbooks,ai-playbooks/%,prompt-library,voice-agents,integrations,integrations/%,tasks,security,webhooks,library,import,feature_permissions}`

### Executive Analytics
- `/executive-analytics/{request-efficiency,missing-documents,treatment-continuity,treatment-velocity,case-costs,settlements}`

### Settlement Data Repository (SDR)
- `/settlements/{get-estimate,estimate,saved/cases,share}`

### SOW app (served by `apps/sow/`, NOT `webapp/`)
- `/sow/matters` | `/sow/matters/%` | `/sow/matters/%/{timeline,details,workstation/%/%}`
- `/sow/leads` | `/sow/leads/%` | `/sow/leads/%/timeline`
- `/sow/contacts` | `/sow/contacts/%`
- `/sow/tasks` | `/sow/reports` | `/sow/reports/%` | `/sow/notifications`
- `/sow/settings/templates` | `/sow/settings/templates/new` | `/sow/settings/templates/new/review` — **SOW templates ≠ LOPS Mirror Mode templates** at `/cases/%/express-demand/templates`
- `/sow/settings/{users-and-roles,users-and-roles/users,users-and-roles/system-roles,users-and-roles/system-roles/%,custom-fields,display-templates}`
- `/sow/internal-tools/{firms,firms/%,internal-users,import-export}`

### Other
- `/knowledge-base` | `/knowledge-base/%` — firm knowledge base
- `/search` | `/search/%` — global search (LegalOps)
- `/annotation` | `/annotation/%` — annotation requests (LegalOps)
- `/diagrams/calendar` — Medicron calendar
- `/redirect/%` — shared-link redirect
- `/login` | `/authenticate` | `/` — auth / root

### URL gotchas
- XD lives at `/cases/%/express-demand/...`, NOT `/demands/...`. The `/demands/%/form/%` routes are the Standard / Expert Demand editor — separate Workstation path. See `workstation.md` for the umbrella structure.
- `/exhibit-preview/%` is a standalone preview pane (~90k pageviews/7d). Exclude from product engagement metrics.
- Path IDs mix UUIDs (cases/plaintiffs/exhibits/MDC) and bare integers (most requests). Use `%` wildcards, not `(\d+)`.
- Trailing slashes vary (`/requests/%` vs `/requests/%/`); normalize when grouping.

## SOW vs LOPS attribution

Monorepo ships two apps emitting into the same Amplitude project. Rules:

| Event type | Attribution signal |
|---|---|
| `[Amplitude] Page Viewed` (pageviews) | `page_path LIKE '/sow/%'` → SOW. Else → LOPS. Last 7d: ~1,866 SOW / ~550k total (~0.3%). |
| Companion events (shared `@evenup/companion`) | `origin` property. `'sow'` → SOW. `'wi'` → LOPS (W&I). `null` → older code. Last 7d: 401 `wi` / 19 types, 37 `sow` / 7 types, all Companion. |
| All other custom events | No reliable tag. ~2.2M events / 409 types have no `origin`. Session-attribute via most-recent pageview. |

Emit sites:
- SOW Companion: `apps/sow/src/features/companion/companion-provider.tsx:399` — sets `origin: "sow"`.
- LOPS Companion: `webapp/src/companion/CompanionWrapper.tsx:384` — sets `origin: app` (= `"wi"` when mounted in LOPS).
- SOW has ad-hoc `track()` calls in `apps/sow/src/features/{users-and-roles,templates,communications,prompt-library}/` — low volume, inconsistent origin tagging.

## Prefix glossary

Once you know the prefix, the rest of the event name is usually self-explanatory.

| Prefix | Meaning | Active events (7d) |
|---|---|---|
| `[FE][XD]` | FrontEnd / eXpress Demand. Events from the XD path of the Workstation (Workstation is the umbrella editor; XD is the customer-driven fast-turnaround path for "easy-tender" case types: MVA, Premises Liability, Dog Bite). Covers editor, exhibit management, AI edits, redaction, toolbar, version history. See `workstation.md`. | 97 |
| `[FE][MM]` | FrontEnd / Mirror Mode. Template-based demand drafting for firms with bespoke formatting. Template CRUD, selection, filters, sorting. | 14 |
| `[Value Drivers Detractors]` | Case Strengths & Weaknesses (CSW / VDD / Case Flags). Internal engineering naming; user-facing product name is Case Strengths & Weaknesses / Case Flags. W&I product. | 6 |
| `[Missing Docs Check]` | MDC — flags documents expected on a case but not yet uploaded. | ~10 |
| `[Case Care]` | Case Care — plaintiff treatment-event timeline. | ~10 |
| `[AI Playbooks]` | Firm-configurable question sets run against case files. | ~15 |
| `[Prompt Library]` | User-managed reusable prompt templates. | few |
| `[SmartTasks]` | Case-level triggers with an approve / reject review-modal workflow. Events: ViewedCaseWithPendingTriggers, OpenedReviewModal, ClickedApprove / Reject, ConfirmedApproval / Rejection, UpdatedRuleConfig, ClickModalClose. Enum: `infrastructure/apm/events/smartTasksEvents.ts:7`. | 2 |
| `[Feed]` | In-app notification / activity feed. Events: ButtonShown, ViewAll, TabChange, MarkAsRead, MarkAllAsRead, MarkFeedItemAsUnread, CtaCompleted. Enum: `infrastructure/apm/events/feedEvents.ts:6`. | 6 |
| `[Exec Analytics]` | Case-list UI at `/executive-analytics/...`. Events: CaseListSort, CaseListFilter, CaseListPaginate, CaseListLinkClick, GlobalStateChange. Enum: `infrastructure/apm/events/execAnalyticsEvents.ts:6`. Audience ("firm leadership") inferred, not confirmed. | 4 |
| `[Voice Agent]` | Plaintiff phone calls (enrollment, call list, call detail). | few |
| `[Amplitude]` | SDK auto-events (`Page Viewed`, `Form Started`, `Form Submitted`). NOT emitted by our code — treat differently. | 3 |

## Non-obvious individual events

File paths relative to `webapp/src/` unless noted.

| Event(s) | What it measures | UI surface | Enum · emit |
|---|---|---|---|
| `PALS Turned On` / `PALS Turned Off` | Toggles case-level `pals_enabled` flag. **PALS = Provider Appointment-Level Summaries** (aka UI label "Provider Summaries at Appointment Level"). Medical-summary format for B+/Hybrid demands ("Med Summaries using PALS"). Service: `caseService.updatePalsEnabled`. Props: `case_id`, `document_type`. Per-case switch inside Exhibit Builder, NOT firm/demand settings. | Exhibit Builder → Provider Summaries at Appointment Level switch | enum `infrastructure/apm/events/palsEvents.ts:5-6` · emit `exhibit-builder/AppointmentSummariesToggle.tsx:81-82` |
| `Provider Shell Time Spent` | **Per-provider** time-spent. One event *per provider* on session end with that provider's accumulated duration. NOT same as Provider Section. Props: `time`, `case_id`, `provider_id`, `document_type`, `document_id`. | Demand editor → individual provider panels | enum `infrastructure/apm/events/demandEvents.ts:13` · emit `demand/utils.ts:98` |
| `Provider Section Started` · `Provider Section Exited` | **Section-level** navigation entry/exit for the Providers section of the demand form. NOT same as Provider Shell. Part of 15-section lifecycle (see demand-section family below). | Demand editor → Providers section route | enum `infrastructure/apm/events/demandSectionEvents.ts:36-37` · helper `demandSectionEvents.ts:87` |
| Demand-section family: `{Section Name} Started / Exited` | Section-level nav entry/exit via `logDemandSectionEvent`. Section enum ≠ event name for several — mismatches: `non_economic` → **Per Diem Analysis**; `household_loss` → **Loss of Household Services**; `damages_sections` → **Additional Damages**; `exhibits` → **Arrange Exhibits**; `case_attributes` → **Select Templates**. `law_firm` emits no events. Unmapped → `Unknown Demand Section entered/exited`. Props: `request_id`, `demand_id`. | Demand editor → section routes | mapping `infrastructure/apm/events/demandSectionEvents.ts:14-76` · helper `:87-111` |
| `Provider Details Edit Started` / `Ended` | Redux-reducer-driven on provider edit-state transitions. NOT modal open/close. `Started` on `SET_EDITING`; `Ended` on `TOGGLE_DELETING` + other terminal actions. Props: `demand_id`, `request_id`, `provider_name`, `provider_type`. | Demand editor → Providers → per-provider edit state | enum `infrastructure/apm/events/demandEvents.ts:15-16` · emit `demand/Providers/store/reducer/index.ts:498` (Started), `:562` / `:656` (Ended) |
| `AskAI Clicked` | AI-copilot button (`AskAIButton`) click in the demand editor toolbar. Toggles an AI panel. Demand-editor-specific — NOT Case Companion. Props: `demand_id`, `request_id`, `request_type`. | Demand editor toolbar | enum `infrastructure/apm/events/demandEvents.ts:10` · emit `demand/components/CaseEditor.tsx:131` |
| `Exhibit Builder Turned On / Off` · `Demand Exhibit Builder Time Spent` · `withExhibitBuilder` property | Destructive case-level mode. Toggle gated by confirmation modal "Reset all Providers" — copy: *"...will permanently undo all exhibit actions and delete all provider summaries, bills, and ICD codes."* Props: `source` enum (`DemandExhibitBuilder` or `MedicalChronologyExhibitBuilder`), `case_id`, `document_type`. `withExhibitBuilder` on demand events derived from `caseObj.use_exhibit_builder`. | Demand editor → Exhibit Builder toggle | enum `infrastructure/apm/events/exhibitBuilderEvents.ts:11-12` · emit `exhibit-builder/ExhibitBuilderToggle.tsx:43-45` · reset-modal copy `:70-78` |
| `Plaintiff Overlap Detected` | Fires on exhibit plaintiff-dropdown change when the "Overlapping Plaintiff Records Found" modal opens (two exhibits carry same plaintiff). Modal copy: *"multiple relations records for the same plaintiff."* Only prop: `case_id`. | Exhibit Builder → per-exhibit plaintiff dropdown | enum `infrastructure/apm/events/exhibitBuilderEvents.ts:16` · emit `exhibit-builder/UserExhibitList/UserExhibit/PlaintiffDropdown.tsx:84` |
| `Saw Credit Overage Alert` / `Deferred from Credit Overage` | Credit-overage alert on request submit. Alert UI breaks into 5 line items: **Base Cost, Additional Page Charge, Additional Plaintiff Charge, Additional Verdict Charge, Additional Revision Page Charge** (UI labels). Only `credit_total`, `plaintiff_name`, `request_id`, `request_type` make it to the event — line items NOT sent. "Deferred" = user backed out. See `billing_credits.md`. | Request form → submit-attempt alert | enums `infrastructure/apm/events/requestEvents.ts:12,14` · emit `requests/RequestForm/SinglePageRequestForm/components/ExpensiveRequestNotification.tsx:100` · categories `:76-92` |
| `Collective Statement Download Started / Successful / Error` · `Start Date Edited / End Date Edited` · `Previous Month Clicked` · `Previous Week Clicked` (code exists, 0 fires in 7d) | Firm-wide billing receipt download (aka Collective Work Statement / Statement of Work). Date-range filterable CSV/PDF. Attribution by DELIVERY date (not submit) — see `billing_credits.md`. | Settings → Firm → Statement of Work | `settings/Firm/FirmDetails/StatementOfWork.tsx` — lines `62` StartDateEdited, `73` EndDateEdited, `91` PreviousWeekClicked, `108` PreviousMonthClicked, `124` DownloadSuccessful, `144` DownloadError, `167` DownloadStarted |
| `Web Viewable Medical Chronology Viewed` + 9 related (Filtered By Provider / Time Range / Medical Professionals; Sorted By Provider; Jumped To Section; Date In Calendar Clicked; PDF Downloaded; Exhibit Reference Clicked; Shared) | "Web Viewable" = chronology rendered at `/documents/:docId/view-medical-chronology/` (browser viewer; separate from PDF or editable-internal surface). | `/documents/:docId/view-medical-chronology/` | enums `infrastructure/apm/events/medicalChronologyEvents.ts:12-21` |
| `[Case Care] Zoom To Changed` | Time-range window change on Case Care timeline. `zoom_to` property = `TimeRange` enum: `last_month`, `last_3months`, `last_6months`, `last_year`, `since_incident`. | Case Care timeline → Zoom To control | enum `cases/CaseCare/case-care.events.ts:16` · emit `cases/CaseCare/CaseCareZoomTo.tsx:24` · enum values `cases/CaseCare/CaseCareView.types.ts:8` |

## Instrumentation-only events — NOT for product KPIs

Performance telemetry, batched via 2s debounce or flushed every 200 samples (`useRichTextPerformance` at `webapp/src/utils/performanceAnalytic.ts:13-35`). Each carries render-time percentiles (50/75/90/95/99.99). Counts correlate with render volume, not engagement.

- `File Upload Timing Tracked` (178k / 7d)
- `Rich Text Symbol Rendered` (174k / 7d) — `isPlateEditor=false` branch
- `Plate Editor Rich Text Symbol Rendered` (42k / 7d) — `isPlateEditor=true` branch

Enum: `webapp/src/infrastructure/apm/events/applicationPerformanceEvents.ts`. Emit: `webapp/src/utils/performanceAnalytic.ts:18-31`.
