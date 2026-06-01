---
aliases: [workstation, demand editor, demand letter, Express Demand, XD, Standard Demand, Expert Demand, legacy demand editor, Mirror Mode, MM, Exhibit Builder, PALS, Provider Appointment-Level Summaries, pals_enabled, AskAI, AskAI Clicked, Provider Shell, Provider Section, Provider Details Edit, FME, Per Diem Analysis, Loss of Household Services, Arrange Exhibits, logDemandSectionEvent]
key_events: [PALS Turned On, PALS Turned Off, Provider Shell Time Spent, Provider Section Started, Provider Section Exited, Provider Details Edit Started, Provider Details Edit Ended, AskAI Clicked, Exhibit Builder Turned On, Exhibit Builder Turned Off, Demand Exhibit Builder Time Spent, Plaintiff Overlap Detected, Future Medical Expenses Started, Future Medical Expenses Exited, Per Diem Analysis Started, Per Diem Analysis Exited, Loss of Income Started, Loss of Household Services Started, Arrange Exhibits Started, Select Templates Started, Pain and Suffering Started, Case Facts Started, Plaintiff Information Started, Introduction Started, Carrier Information Started, Conclusion Started, Missing Documents Started, Additional Damages Started]
event_prefixes: ["[FE][XD]", "[FE][MM]"]
related: [frontend_events.md, product_truth.md, billing_credits.md, bills_summary.md]
source_paths: [lops-frontend/webapp/src/demand/, lops-frontend/webapp/src/express-demand/, lops-frontend/webapp/src/exhibit-builder/]
last_audit: 2026-04-28
ticket: DA-1269
---

# Workstation — lops-frontend Editing Interface

"Workstation" is the umbrella term for the in-browser demand-editing interface in `lops-frontend`. It hosts two distinct editor paths (XD and Standard/Expert Demand) and a template mode (Mirror Mode).

## Workstation structure

| Term | Aliases | Code path | URL surface | Amplitude |
|---|---|---|---|---|
| **Workstation** | editor, demand editor | — (umbrella term) | — (umbrella) | Events like `[FE][XD] Workstation loaded`, `Workstation time spent`, `Workstation copy/paste event`, `Workstation Companion panel opened/closed`, `Workstation expert package downloaded` — fire from the XD path; `Workstation` literal appears in XD event names. |
| **Express Demand (XD)** | eXpress Demand, workstation-XD | `lops-frontend/webapp/src/express-demand/` | `/cases/:caseId/express-demand/%` | `[FE][XD]` prefix (97 distinct events / 7d). Fast-turnaround demands for "easy-tender" case types (MVA, Premises Liability, Dog Bite); customer drives the editing. |
| **Standard Demand** | Expert Demand, legacy demand editor, core demand | `lops-frontend/webapp/src/demand/` | `/demands/:id/form/%` | No prefix. Uses generic `DemandAnalyticEvent` / `DemandSectionEvent`. LOPS drafts with 1-3 day turnaround; customer reviews. |
| **Mirror Mode (MM)** | [FE][MM], template mode | Inside XD + shared template logic | `/cases/:caseId/express-demand/templates/%` | `[FE][MM]` prefix (14 events / 7d). Template-based drafting where user uploads a sample; AI mirrors its format/tone. **Not limited to demands** — also used for Complaints, Medical Summaries, Initial Disclosures, and other document types. Uses Workstation with template-mirroring generation logic. |

Both editor paths share the demand-section helper (`demandSectionEvents.ts`) and several event classes. Many non-prefixed events (`Provider Shell Time Spent`, `Provider Details Edit Started`, `AskAI Clicked`, etc.) can fire from either path. Attribute via page_path: `/cases/%/express-demand/%` → XD, `/demands/%/form/%` → Standard.

## Demand sections — code enum ↔ event name

15-section lifecycle via `logDemandSectionEvent` at `infrastructure/apm/events/demandSectionEvents.ts:87`. Section enum name in code DOES NOT match the Amplitude event name for several sections — single most common pitfall.

| Section enum (code) | Amplitude event name |
|---|---|
| `case_attributes` | Select Templates Started / Exited |
| `plaintiff` | Plaintiff Information Started / Exited |
| `introduction` | Introduction Started / Exited |
| `carrier` | Carrier Information Started / Exited |
| `facts` | Case Facts Started / Exited |
| `providers` | **Provider Section** Started / Exited |
| `pain_and_suffering` | Pain and Suffering Started / Exited |
| `future_expenses` | **Future Medical Expenses** (FME) Started / Exited |
| `non_economic` | **Per Diem Analysis** Started / Exited ⚠️ mismatch |
| `income_loss` | Loss of Income Started / Exited |
| `household_loss` | Loss of Household Services Started / Exited |
| `damages_sections` | Additional Damages Started / Exited |
| `exhibits` | Arrange Exhibits Started / Exited |
| `missing_documents` | Missing Documents Started / Exited |
| `law_firm` | (no events — intentional) |
| `conclusion` | Conclusion Started / Exited |

- `non_economic` → Per Diem Analysis (non-economic damages are primarily per-diem-calculated; distinct from the `pain_and_suffering` section).
- `household_loss` → Loss of Household Services (internal name `household_loss`; user-facing term LoHS).
- `damages_sections` → Additional Damages (custom damage categories beyond the standard set).
- Unmapped section → `Unknown Demand Section entered` / `exited`.

Event payload: `request_id`, `demand_id`. Mapping defined `demandSectionEvents.ts:14-76`; helper `:87-111`.

## Providers — three distinct event families

Three granularities, often conflated. Use the right one:

| Event family | Granularity | What it measures | Emit site |
|---|---|---|---|
| `Provider Section Started` / `Exited` | Section-level nav | Entry/exit of the `providers` demand-form route | `demandSectionEvents.ts:36-37` |
| `Provider Shell Time Spent` | Per-provider | One event *per provider* on session end with that provider's accumulated panel-open duration. Props: `time`, `case_id`, `provider_id`, `document_type`, `document_id`. | `demand/utils.ts:98` |
| `Provider Details Edit Started` / `Ended` | Per-provider edit lifecycle | Redux-reducer-driven (NOT modal open/close). `Started` on `SET_EDITING`; `Ended` on `TOGGLE_DELETING` + other terminal actions. Props: `demand_id`, `request_id`, `provider_name`, `provider_type`. | `demand/Providers/store/reducer/index.ts:498` (Started), `:562` / `:656` (Ended) |

For "time spent on providers", sum `Provider Shell Time Spent` per `case_id`. `Provider Section Started / Exited` = URL navigation only. `Provider Details Edit` fires multiple times per provider (each edit cycle).

## Exhibit Builder

Case-level togglable mode that replaces manual bill/record management with an automated document-organization UI (extraction, partitioning, summarization). State: `caseObj.use_exhibit_builder`. Service: `caseService.useExhibitBuilder`.

**Destructive toggle.** Confirmation modal titled "Reset all Providers" — copy: *"...will permanently undo all exhibit actions and delete all provider summaries, bills, and ICD codes."* (`ExhibitBuilderToggle.tsx:70-78`). Count toggles carefully — many are real resets.

`withExhibitBuilder: boolean` property on demand events (`Demand Generated`, `Medical Chronology Submitted`, etc.) is derived from `caseObj.use_exhibit_builder` at generation time — clean signal for "generated in EB mode".

Events:
- `Exhibit Builder Turned On` / `Turned Off` — toggle. Props: `source` enum (`DemandExhibitBuilder` or `MedicalChronologyExhibitBuilder`), `case_id`, `document_type`. Enum `exhibitBuilderEvents.ts:11-12`, emit `ExhibitBuilderToggle.tsx:43-45`.
- `Demand Exhibit Builder Time Spent` / `Medical Chronology Exhibit Builder Time Spent` / `Intake Files Time Spent` — duration metrics.
- `Plaintiff Overlap Detected` — fires when exhibit plaintiff-dropdown change opens "Overlapping Plaintiff Records Found" modal (two exhibits carry same plaintiff). Props: `case_id` only. Enum `:16`, emit `UserExhibitList/UserExhibit/PlaintiffDropdown.tsx:84`.

## PALS

**PALS = Provider Appointment-Level Summaries.** UI label to users: "Provider Summaries at Appointment Level" (same meaning, reworded). Medical-summary format for B+/Hybrid demands (firm instructions: "Med Summaries using PALS").

Case-level toggle inside Exhibit Builder. NOT a firm-level setting.

| Name surface | Form |
|---|---|
| Code / events / backend flag | `PALS` / `pals_enabled` / `PALS Turned On` / `PALS Turned Off` |
| UI label | "Provider Summaries at Appointment Level" |
| Acronym expansion | Provider Appointment-Level Summaries |

Service: `caseService.updatePalsEnabled`. Enum `infrastructure/apm/events/palsEvents.ts:5-6`. Emit `exhibit-builder/AppointmentSummariesToggle.tsx:81-82`. Props: `case_id`, `document_type`.

## AskAI

AI-copilot button (`AskAIButton`) in the demand editor toolbar. Click toggles an AI edit panel (`setOpenAskAi` state at `demand/components/CaseEditor.tsx:126-138`).

Fires `AskAI Clicked` — `DemandAnalyticEvent` with `demand_id`, `request_id`, `request_type`. Demand-editor-specific (NOT Case Companion). 1,092 events / 144 users / 7d. Enum `demandEvents.ts:10`, emit `CaseEditor.tsx:131`.

## Workstation Engagement & Feature Flags

**Editing behavior:** Only ~5% of AI Drafts are edited in Workstation. Most users download the generated document and edit in Word instead.

**Key feature flags tied to Workstation:**
- `workstation_comments` — inline commenting
- `workstation_styling_controls` — font and formatting options
- `workstation_sse` — integration with Bill Summary for real-time billing data
