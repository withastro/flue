# FLP / CLP Pipeline

## What They Are

**FLP (File Level Pipeline)** processes individual files — running a set of ML transforms (e.g. page classification, billing extraction) on each file uploaded to a matter. Each transform produces a `filelevelpipelineoutput` record in annotation-service.

**CLP (Case Level Pipeline)** runs at the matter/case level. It takes a snapshot of the matter's files, runs case-level entity extraction, and produces structured entities (medical records, billing items, etc.). A matter can have many CLP snapshots as new files are added and CLP re-runs.

## Cost Optimization Framework

CLP depends entirely on FLP output. This creates a two-gate optimization hierarchy:

**Gate 1 — "Will the client ever engage?" (governs FLP and transitively CLP)**
- If NO: skip FLP entirely. Because CLP consumes FLP output, CLP also never runs. This is the primary cost lever for historical ingest, closed cases, and any matter unlikely to see client interaction.
- If YES: run FLP, then proceed to Gate 2.

**Gate 2 — "Will the client engage soon, and is the file set stable?" (governs CLP timing only)**
- Determines *when* to trigger CLP, not whether. See CLP Re-run Logic section below.

## Triggering Logic

### FLP
FLP fires on **every file upload, for every firm** — CI and non-CI alike. There is no feature flag gating FLP. The optimization opportunity is Gate 1: skip FLP (and therefore CLP) on matters where P(client ever engages) is below a threshold.

### CLP
CLP triggering is **feature-flag controlled per firm**. Three flags exist:

| Flag | Behavior |
|------|----------|
| `run_clp_no_restrictions` | CLP fires on every file upload (no delay). Historically used by ~20 CI firms; now largely deprecated in favor of `run_clp_with_wait`. |
| `run_clp_with_wait` | CLP auto-runs every 7 days when new files are added, OR immediately on-demand when a user triggers a CLP-dependent feature (e.g. clicks "Generate Timeline" or "Run MDC"). |
| `clp_timer_from_firm_config` | Timer interval is set per firm in config rather than a binary flag. Likely the future architecture. |

**Non-CI firms (no flag):** CLP fires automatically on every file upload — same as `run_clp_no_restrictions`. Non-CI matters tend to have higher engagement rates than CI matters because clients manually upload files, meaning they are actively working those cases.

**CI firms with no CLP flag:** CLP only runs on-demand (user triggers a CLP-dependent feature).

### On-demand CLP triggers
The W&I features that trigger an on-demand CLP run (if no up-to-date snapshot exists covering all current files):
- Mirror Mode (MM)
- Missing Docs Check (MDC)
- Bill Summary
- Treatment Timelines
- Any view (client visiting the case page)

**Note:** AI Playbooks does **not** use CLP. It uses case-qa/RAG independently.

## CLP Re-run Logic and the Optimization Problem

CLP is **not additive** — running CLP on 3 files does not carry forward when 10 files are eventually present. Each run processes all currently uploaded files from scratch. This has two implications:

1. **Running too early is wasteful** — if more files are coming and the client isn't about to engage, the run will be redundant.
2. **The ideal run is timed to just before the client needs CLP output**, after the file set is reasonably stable.

A CLP re-run after new file uploads is only justified when **both** conditions hold:
- P(client engages soon) is high enough to warrant running now
- The current file set is stable enough that waiting for more uploads is unlikely to improve the snapshot

If engagement is not expected soon, it is smarter to wait — more files may arrive, and CLP can be run once when the matter is ready.

## Engagement Data (CI Matters, May 2026)

From Emre's CI Engagement Report (`cost-analysis-tool.apps.evenup.law/api/reports/report_ci_engagement`):

| Flag | Firms | CI Matters | Lifetime touch rate (any surface) | 12-week maturity-gated |
|------|-------|------------|-----------------------------------|------------------------|
| `run_clp_no_restrictions` | 8 | 15,158 | 16.8% | 29% |
| `run_clp_with_wait` | 32 | 63,927 | 21.6% | 14% |
| `clp_timer_from_firm_config` | 1 | 14,730 | 9.8% | 3% |
| **All CI** | **41** | **93,815** | **19.0%** | — |

**~81% of CI matters that have CLP running never see client engagement.** Non-CI matters have higher engagement rates (to be quantified — no prior analysis as of May 2026).

Surface-level breakdown (lifetime, `run_clp_with_wait` as reference):
Bill Summary 5.2% · Timeline 4.9% · Missing-Doc Check 9.7% · Express Demand 14.4% · Mirror Mode 5.0%

## Historical Ingest

CI ingest is scheduled at each firm's discretion — it is not necessarily tied to onboarding. Firms may bulk-ingest large volumes of historical/closed cases at any time. These cases may never see client engagement and represent meaningful CLP spend.

Byron Poplawski (CS/Integrations) maintains a SQL query that identifies CI firms with their historical ingest end date (distinguishing historical backfill matters from ongoing CI matters). Reference: `#analytics-guild` Slack thread, ~Jan 2026. **Caveat from Byron:** the cutoff is not a perfect boundary between historical and ongoing.

## CLP Internal Architecture

CLP is not a single inference call — it executes ~18 transforms across 3 phases. Understanding this is critical for cost attribution.

**Phase 1 (parallel):** Billing V6 CLP, Medchron Staging, OT Flow, IT Flow, ITR Processor, ICD Code Flow, Date of Incident, Therapies, Surgeries, Objective Tests (FME)

**Phase 2 (parallel):** Medchrons CLP, Objective Tests (FME), Matter Injury Severity, Billing V2 (fallback only if V6 fails)

**Phase 3 (sequential):** Cross-model reconciliation → OT/IT v2 → Post-reconciliation update → Encounter Provider Type → Visit Relevancy Classification → Missing Doc Check v3

**Heaviest models (cost):**
- Gemini 2.5 Pro: Medchrons CLP aggregation (up to 30+ iterative stages for large cases)
- Opus 4.5: Billing V6 provider grouping and deduplication
- o3: Cross-model reconciliation name stabilization

**Experimental transforms (fail silently, don't fail CLP):** Billing V6 CLP, OT/IT v2, Visit Relevancy Classification, Page Level Metadata, Matter Injury Severity

**Billing V2 fallback:** Runs only if Billing V6 produces empty output or fails. RAG-based, Sonnet 4.5 × 7 steps — effectively doubles billing cost on V6 failures.

**FME (Future Medical Expenses):** Therapies, Surgeries, and Objective Tests run in Phase 1/2 and feed case valuation products. Downstream consumers of FME outputs need verification.

**MDC timing implication:** MDC v3 is the last transform in Phase 3. An on-demand CLP triggered by a user clicking MDC must run the entire 3-phase pipeline (20–40 min) before MDC output is ready. Gate 2 timing for MDC-triggered runs is effectively zero — CLP must have been run proactively.

## CLP Fast-Forward (shipped ~Apr 2026)

An intra-run optimization: when FLP billing page classification determines a newly uploaded file is not billing-relevant, the CLP billing model skips rerunning for that file and reuses results from the prior snapshot. This reduces compute within a CLP run but does **not** gate whether a CLP run fires at all. The ~81% waste from unnecessary runs is not addressed by fast-forward.

## Key Nuances

**Partial file runs (since Nov 2025):** CLP supports `snapshot_type = 'partial_files'` where only a subset of files is processed, rather than all AI-relevant files on the matter. The file list is stored as a JSON array in `clp_parameters.parameters.files`. Before Nov 2025, all runs were `full`.

**A matter has multiple CLP snapshots:** Each time CLP re-runs (new files, partial refresh), a new snapshot is created. `snapshot_type` and `file_selection_hash` distinguish runs.

**FLP and CLP are not directly linked:** The connection is through `file_upload_id`. CLP selects files by `file_upload_id`; FLP outputs are keyed by `file_upload_id`. There is no direct FK between CLP snapshot rows and FLP output rows.

**A file can be processed under multiple annotation requests:** FLP runs are keyed by `(file_upload_id, annotation_request_id)` — not just file.

**CI Orphan FLP:** Cases where FLP ran but CLP never ran. Whether this is intentional (CI firms with no CLP flag) or a gap needs eng verification.

## Historical Data Gaps

- `snapshot_type`: NULL for snapshots created before Nov 2025 (~62k rows). Not a bug — field didn't exist yet.
- `selected_file_count` in `fact_clp`: 0 for full snapshots before ~Mar 2026. `clp_parameters` was not populated for full runs historically. Partial runs are unaffected.
- `flp_to_clp_seconds`: not a reliable global latency metric — can be 50+ days for historical matters where FLP ran long before a new CLP snapshot was created. Only meaningful filtered to near-real-time flows.
