# Metabase Scripts

## Setup

```bash
export METABASE_API_KEY='your-api-key-here'
```

## Usage

```bash
./metabase-cli.py --help                     # top-level commands
./metabase-cli.py creation --help            # shared args + all viz types
./metabase-cli.py creation bar --help        # --viz-settings JSON reference for bar
./metabase-cli.py creation stacked-bar --help
./metabase-cli.py research --help            # research by dbt model or card ID/name
```

## Filters / Template Tags

Metabase native SQL cards support filter widgets via `{{variable}}` syntax.
`metabase-creator.py` auto-detects `{{variable_name}}` in SQL and populates
`template-tags` in the API payload. **If template-tags is empty but the SQL
contains `{{...}}`, Metabase silently discards the query.**

### Filter decision tree

1. **Does the user need to filter this column?** If no, hardcode the value in SQL.
2. **Is the column low-cardinality (firm names, statuses, categories)?**
   → Use `dimension` filter (dropdown). Requires `--field-filters` with field_id.
3. **Is the column a date/timestamp the user should pick from a calendar?**
   → Use `dimension` filter with `widget_type: "date/all-options"`.
4. **Is the column numeric and the user needs a range (e.g. revenue > X)?**
   → Use `dimension` filter with `widget_type: "number/between"`.
5. **Is it free-text search (substring match)?**
   → Use `text` filter (default — no `--field-filters` entry needed).

### Required vs optional filters

**Required** — always shown, card won't run without a value:
```sql
WHERE firm_name = {{firm_name}}
```

**Optional** — omitted when blank. Wrap the full condition including `AND` in `[[ ]]`:
```sql
WHERE
    deleted_at IS NULL
    [[AND lower(firm_name) LIKE lower(concat('%', {{firm_name}}, '%'))]]
```

Metabase removes `[[...]]` blocks when blank. **The first condition must NOT be
optional** — `WHERE` needs at least one non-optional condition to be valid SQL.

### Text filters (default)

Any `{{var}}` not in `--field-filters` becomes a text input. The value is substituted
literally into SQL — you write the full condition:

```sql
[[AND lower(col) LIKE lower(concat('%', {{search_term}}, '%'))]]
```

### Dimension filters (dropdown/calendar/numeric)

Pass `--field-filters` to promote variables to dimension filters. Metabase generates
the WHERE condition — SQL just uses `[[AND {{var}}]]`:

```sql
[[AND {{firm_name}}]]
```

#### `--field-filters` format

```json
{
  "var_name": {
    "field_id": 485405,
    "alias": "t.column_name",
    "widget_type": "string/="
  }
}
```

Shorthand (string/= only): `{"var_name": 485405}`

#### widget_type reference

| widget_type | UI | Use when |
|---|---|---|
| `string/=` | Dropdown, multi-select | String column, user picks exact values (default) |
| `string/contains` | Text input | String column, substring match via dropdown |
| `category` | Dropdown | Low-cardinality column (status, type, tier) |
| `number/=` | Number input | Exact numeric match |
| `number/between` | Two number inputs | Numeric range (revenue between X and Y) |
| `number/>=` | Number input | Numeric lower bound |
| `number/<=` | Number input | Numeric upper bound |
| `date/single` | Date picker | Exact date |
| `date/range` | Two date pickers | Date range (from → to) |
| `date/relative` | Preset selector | "Last 7 days", "This month", "Previous quarter" |
| `date/month-year` | Month picker | Monthly granularity |
| `date/quarter-year` | Quarter picker | Quarterly granularity |
| `date/all-options` | Full date UI | All date filter modes — **use this as the default for dates** |
| `id` | Number input | ID lookup |

#### Looking up field IDs

Find the Metabase table ID, then list its fields:

```bash
# Find table ID by name
curl -s -H "x-api-key: $METABASE_API_KEY" "https://metabase.evenup.law/api/table" | \
  python3 -c "import json,sys; [print(t['id'], t['name']) for t in json.load(sys.stdin) if 'portal_user' in t['name'].lower()]"

# List fields for that table
curl -s -H "x-api-key: $METABASE_API_KEY" \
  "https://metabase.evenup.law/api/table/<table_id>/query_metadata" | \
  python3 -c "import json,sys; [print(f['id'], f['name'], f['base_type']) for f in json.load(sys.stdin)['fields']]"
```

### Alias rules (critical for BigQuery)

1. **Always give FROM tables a short SQL alias** (`AS t`, `AS pu`). Never use the
   project-qualified path — `evenup-bi` hyphens are parsed as subtraction by BigQuery.
2. The `alias` in `--field-filters` must be `"<table_alias>.<column>"` matching the
   AS alias in SQL (e.g. `"pu.firm_name"`).
3. `[[AND {{var}}]]` must be in the **same SQL scope** as the aliased table.

#### Placement by query shape

**Simple:**
```sql
FROM `evenup-bi.dbt_prod.dim_portal_users` AS pu
WHERE pu.deleted_at IS NULL [[AND {{firm_name}}]]
```

**JOIN** — filter in outer WHERE, alias points to the owning table:
```sql
FROM `evenup-bi.dbt_prod.dim_portal_users` AS pu
JOIN `evenup-bi.dbt_prod.dim_firms` AS f ON f.firm_id = pu.firm_id
WHERE pu.deleted_at IS NULL [[AND {{firm_name}}]]
-- field_filters: {"firm_name": {"field_id": 485405, "alias": "pu.firm_name"}}
```

**CTE** — filter goes INSIDE the CTE body, not the outer SELECT:
```sql
WITH base AS (
    SELECT pu.firm_name, pu.full_name
    FROM `evenup-bi.dbt_prod.dim_portal_users` AS pu
    WHERE pu.deleted_at IS NULL [[AND {{firm_name}}]]
)
SELECT * FROM base ORDER BY firm_name
```

Never filter in the outer SELECT on a CTE — Metabase can't resolve the alias there.

### Full example

```bash
metabase-cli.py creation table \
  --name "Firm Users" \
  --query "SELECT pu.firm_name, pu.full_name, pu.created_at FROM \`evenup-bi.dbt_prod.dim_portal_users\` AS pu WHERE pu.deleted_at IS NULL [[AND {{firm_name}}]] [[AND {{created_after}}]] ORDER BY firm_name" \
  --field-filters '{"firm_name": {"field_id": 485405, "alias": "pu.firm_name"}, "created_after": {"field_id": 485410, "alias": "pu.created_at", "widget_type": "date/all-options"}}'
```
