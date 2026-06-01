# Manifest Search

Use `manifest_search.py` as the primary index when you need to find which model(s) cover a topic, entity, or column. Returns only the minimum fields agents need.

**Use this when:** you don't yet know which model to look at.
**Skip this when:** you already know the model name — go directly to `Read`.

---

## Step 1: Extract and Normalize Keywords

From the question, identify:
- **Entities**: case, matter, firm, attorney, invoice, payment, user, etc.
- **Columns/metrics**: revenue, status, created_at, count, rate, etc.

**Expand abbreviations and acronyms** to their likely snake_case form before searching — the CLI is a dumb substring matcher with no domain knowledge:
- `W&I` → `w_and_i` (or the full term, e.g. `workers_comp`)
- `MVC` → `motor_vehicle_collision`
- `DoI` → `date_of_incident`
- Special characters (`&`, `/`, `-`) should be replaced with `_` or spelled out

Use multi-keyword AND as the default strategy — it narrows results and avoids truncation. "Law firm revenue" → `search firm revenue` (single command, AND logic).

---

## Step 2: Search via Sub-Agent

Delegate discovery to a sub-agent so the main context window stays clean.

**Invoke Agent tool** (`subagent_type=Explore`) with this prompt template:

> Find dbt models related to [TOPIC]. Run:
>
> ```bash
> python .claude/scripts/manifest_search/manifest_search.py search <keyword1> <keyword2> [--type name|column|description|all] [--logic and|or]
> ```
>
> Parse the JSON output and return the result.

**Sub-agent returns:** model list as compact JSON

### Handling truncation

If the result is `{"truncated": true, ...}`, do NOT iterate `top_10` one by one. Instead, refine the search:
- Add more keywords to narrow: `search firm revenue active`
- Scope with `--type`: `search firm --type name`
- Use AND logic (default) instead of OR

### Scoped search (columns only)
```bash
python .claude/scripts/manifest_search/manifest_search.py search attorney_id matter_id --type column
```

---

## Step 3: Identify Layer

Results are pre-sorted by layer preference (mart > fct/dim > int > stg)

---

## Step 4: Trace Lineage (optional — find upstream/downstream models)

```bash
python .claude/scripts/manifest_search/manifest_search.py lineage fct_cases --direction both --depth 2
python .claude/scripts/manifest_search/manifest_search.py lineage stg_cases --direction upstream
```

Each result includes `depth` (negative = upstream, 0 = root, positive = downstream).

---

## Step 5: Inspect Candidate

Use `path` from the search output to `Read` the actual `.sql` file. Verify logic, joins, and grain.

For the resolved BigQuery path, use dbt_prod as dataset

---

## Step 6: Synthesize

Once the right model(s) are identified, return to the mode-specific workflow (consultation.md or development.md).
