---
aliases: [credits, credit overage, credit_fee, cost_per_credit, auto_credit_amount, Saw Credit Overage Alert, Deferred from Credit Overage, calculate_credits, Collective Statement, Collective Work Statement, Statement of Work, SoW, firm billing, usage-based billing, base_credit, plaintiff_overage, verdict_overage, files_overage, revision_files_overage]
key_events: [Saw Credit Overage Alert, Deferred from Credit Overage, Collective Statement Download Started, Collective Statement Download Successful, Collective Statement Download Error, Collective Statement Start Date Edited, Collective Statement End Date Edited, Collective Statement Previous Month Clicked, Collective Statement Previous Week Clicked]
related: [frontend_events.md, product_truth.md, bills_summary.md, workstation.md]
source_paths: [lops-frontend/webapp/src/requests/RequestForm/SinglePageRequestForm/components/ExpensiveRequestNotification.tsx, lops-frontend/webapp/src/settings/Firm/FirmDetails/StatementOfWork.tsx]
last_audit: 2026-04-21
ticket: DA-1269
---

# Billing: Credits & Collective Work Statement

Document-request billing at EvenUp. Two surfaces: per-request credit-overage alert + firm-wide statement download. Not documented in Confluence; terminology spread across Slack + code.

## Credits — the billing unit

- `credit` = usage-based billing unit for document requests (Expert Docs / demands / medical chronologies / etc.).
- Firms contract for a **monthly credit allowance** as part of their subscription (e.g. "10 credits / month", "1 credit / month on a 12-month term"). Usage above allowance = **overage**, charged per credit.
- Cost formula: `credit_fee = cost_per_credit × auto_credit_amount`.
- Backend: `calculate_credits` endpoint returns a breakdown per request before submit.

## Credit overage — 5 line items

Shown on the Credit Overage Alert at request submit (`requests/RequestForm/SinglePageRequestForm/components/ExpensiveRequestNotification.tsx:76-92`).

| UI label | Frontend field | Backend field | What it charges for |
|---|---|---|---|
| Base Cost | `base_credit` | `base_credit` | The request itself, up to the per-plaintiff page cap: `medical_records_page_cap × plaintiffsCount` |
| Additional Page Charge | `files_overage_credits` | `files_overage_fee` | Pages beyond the per-plaintiff cap (count: `overage_page_count`) |
| Additional Plaintiff Charge | `plaintiff_overage_credits` | `plaintiff_overage_fee` | Plaintiffs beyond the first; multiplied by `(plaintiffsCount - 1)` when ≥ 3 total |
| Additional Verdict Charge | `verdict_overage_credits` | `verdict_overage_fee` | Verdict add-on |
| Additional Revision Page Charge | `revision_files_overage_credits` | `revision_files_overage_fee` | Pages in revision files |

UI calls these "Additional … Charge"; engineering / Slack / backend calls them "overage" (e.g. `plaintiff_overage`). Both forms appear in the wild.

### Events
- `Saw Credit Overage Alert` — fires when the alert shows. Enum `requestEvents.ts:12`.
- `Deferred from Credit Overage` — user backed out of submitting after seeing alert. Enum `requestEvents.ts:14`.
- Emit: `ExpensiveRequestNotification.tsx:100`.
- Event payload only carries: `credit_total`, `plaintiff_name`, `request_id`, `request_type`. Individual line-item amounts are NOT sent to Amplitude. To reconstruct line-items, join to backend `calculate_credits` response.

## Collective Work Statement

Firm-wide billing receipt covering all document requests delivered to a firm in a date range. Downloaded by firm / CSM from the portal.

- Location: Settings → Firm → `evenup.law/settings/firms/{firm_id}`. Component: `settings/Firm/FirmDetails/StatementOfWork.tsx`.
- Formats: CSV (confirmed). Event payload has `file_format` property → more than one format supported (PDF likely; not personally verified).
- Date range: user-editable `start_date` / `end_date`; UI has "Previous Month" + "Previous Week" nav buttons.

### ⚠️ Attribution rule — DELIVERY date, not REQUEST date

Requests land on the Collective Work Statement for the period in which they were **delivered**, not the period in which they were submitted.

Example: request submitted Nov 25, delivered Dec 2 → appears on the **December** statement, not November. When reconciling internal request counts (`mart_lops__request_*` by `created_at`/`submitted_at`) against a firm's Collective Work Statement totals, this mismatch is the #1 source of discrepancy. Use `delivered_at` / equivalent completion timestamp for apples-to-apples.

### Events (all emit from `StatementOfWork.tsx`)
| Event | Line |
|---|---|
| `Collective Statement Download Started` | `167` |
| `Collective Statement Download Successful` | `124` |
| `Collective Statement Download Error` | `144` |
| `Collective Statement Start Date Edited` | `62` |
| `Collective Statement End Date Edited` | `73` |
| `Collective Statement Previous Week Clicked` | `91` (0 fires in 7d) |
| `Collective Statement Previous Month Clicked` | `108` |

## Terminology — same artifact, three names

| Surface | Name used |
|---|---|
| Amplitude `event_type` | `Collective Statement …` |
| Frontend file / component | `StatementOfWork.tsx` |
| Slack / internal chat (CS, Eng) | **Collective Work Statement** (most common) |
| Portal URL | `/settings/firms/{id}` |

For Slack / Confluence search, use "Collective Work Statement" — highest hit rate.

## What this doc does NOT cover

- Credit pricing (`cost_per_credit`, `auto_credit_amount`) — backend contract data, not front-end.
- Overage thresholds / firm allowance config — stored server-side.
- Per-case medical bills (see `bills_summary.md` — different concept: bills inside a matter, not firm billing for document production).
- Non-credit monetization (subscriptions, SOW contracts) — only credit overage + statement-download surfaces.

Internal terminology verified in Slack: `#q4-immaterial-page-discount`, `#analytics-guild`, `#cs-team-mm`, `#2025-q2-discount-expert-docs`.
