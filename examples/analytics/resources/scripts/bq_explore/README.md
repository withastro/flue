# bq_explore.py — BigQuery SQL Executor

Simple, direct SQL executor for BigQuery with a single safety guard: **byte-limit dry-run**.

## Setup

Install dependencies (in your venv):
```bash
uv pip install -r requirements.txt
```

Requires BigQuery authentication via gcloud:
```bash
gcloud auth application-default login
```

## Usage

Execute any SELECT query:
```bash
bq_explore.py "SELECT col1, col2 FROM evenup-bi.dbt_prod.dim_matters LIMIT 10"
```

### Piping from stdin
```bash
cat query.sql | bq_explore.py
echo "SELECT count(*) FROM evenup-bi.dbt_prod.dim_matters" | bq_explore.py
```

### Override byte limit
```bash
# Default: abort if query would scan > 1.0 GB
bq_explore.py "SELECT * FROM large_table" --max-gb 2.0
```

## How It Works

1. **Accepts raw SQL** — Pass any SELECT query as argument or stdin
2. **Validates SELECT-only** — Blocks INSERT, UPDATE, DELETE, DROP, TRUNCATE, CREATE, MERGE, ALTER
3. **Dry-run first** — Estimates bytes via BigQuery dry-run (no cost, instant)
4. **Byte-limit check** — If `total_bytes_processed` > `--max-gb`, aborts with error
5. **Executes query** — Runs the full query (now with cost known)
6. **Writes results to CSV** — Saves to `/tmp/bq_result_<timestamp>_<unique_id>.csv`
7. **Prints summary** — Shows row count, bytes billed, column names, file path

### Example Output
```
✅ Query completed
Rows: 1,234
Bytes billed: 45.2 MB
Columns: case_id, matter_id, created_at
Results written to: /tmp/bq_result_20240226_143022_12345_ab12cd34.csv
```

## Reading Results

Use Claude's `Read` tool to inspect the CSV file (control how much you read):
```
Read /tmp/bq_result_20240226_143022_12345_ab12cd34.csv
```

Claude can also read specific line ranges:
```
Read /tmp/bq_result_20240226_143022_12345_ab12cd34.csv (offset: 1, limit: 50)
```

This prevents large result sets from flooding Claude's context.

## PHI/PII Access

✅ Claude Code is now approved for PHI/PII access. You can query restricted columns directly:
```bash
bq_explore.py "SELECT attorney_full_name FROM evenup-bi.dbt_prod.dim_matters LIMIT 5"
```

Handle sensitive data responsibly per company data handling policies.

## Safety Features

| Feature | Behavior |
|---------|----------|
| **Non-SELECT check** | Rejects DELETE, INSERT, UPDATE, DROP, CREATE, TRUNCATE, MERGE, ALTER |
| **Byte limit** | Default 1.0 GB; aborts if dry-run exceeds threshold. Override with `--max-gb` |
| **Results isolation** | Writes to temp CSV file, never prints rows to stdout (context-safe) |
| **Authentication** | Uses GCP application default credentials (gcloud auth) |

## Limitations

- **SELECT only** — Cannot modify, delete, or drop anything
- **BigQuery only** — Targets evenup-bi project by default (can query any dataset via full path)
- **No result streaming** — All results written to CSV file

## Examples

### Count rows in a table
```bash
bq_explore.py "SELECT count(*) as row_count FROM evenup-bi.dbt_prod.dim_matters"
```

### Find recent activity
```bash
bq_explore.py "SELECT case_id, status, updated_at FROM evenup-bi.dbt_prod.dim_matters WHERE updated_at > '2024-01-01' LIMIT 100"
```

### Complex aggregation
```bash
bq_explore.py "SELECT case_type, count(*) FROM evenup-bi.dbt_prod.dim_matters GROUP BY case_type"
```

### Use a higher byte limit for large tables
```bash
bq_explore.py "SELECT * FROM evenup-bi.dbt_prod.large_fact_table" --max-gb 5.0
```

## Requirements

- `google-cloud-bigquery` (see Setup)
- gcloud CLI with BigQuery authentication
