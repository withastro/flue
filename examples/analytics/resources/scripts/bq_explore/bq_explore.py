#!/usr/bin/env python3
"""
Simple BigQuery SQL executor with cost guard (byte limit via dry-run).

Usage:
    bq_explore.py "SELECT col1, col2 FROM evenup-bi.dbt_prod.dim_matters LIMIT 10"
    bq_explore.py "SELECT ..." --max-gb 2.0
    cat query.sql | bq_explore.py
"""

import sys
import os
import argparse
import csv
import uuid
from pathlib import Path
from datetime import datetime

# Auto-detect and use dbt virtual environment if not already activated
venv_path = None

# First, check if VIRTUAL_ENV is explicitly set
if os.environ.get('VIRTUAL_ENV'):
    venv_path = Path(os.environ['VIRTUAL_ENV'])
else:
    # Otherwise, auto-detect from common locations
    venv_candidates = [
        Path.home() / '.virtualenvs' / 'dbt',  # virtualenvwrapper
        Path(__file__).resolve().parent.parent.parent / '.venv',  # project-local venv
        Path(__file__).resolve().parent.parent.parent / 'venv',  # alternative venv name
        Path('/opt/rstudio-connect/mnt/app/python/env'),  # Posit Connect
    ]

    for candidate in venv_candidates:
        if candidate.exists() and (candidate / 'bin' / 'python').exists():
            venv_path = candidate
            break

# Add venv site-packages to sys.path if we found a venv
if venv_path:
    import site
    site_packages = list(venv_path.glob('lib/python*/site-packages'))
    if site_packages:
        sys.path.insert(0, str(site_packages[0]))
        os.environ['VIRTUAL_ENV'] = str(venv_path)

from google.cloud import bigquery


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Execute raw SQL queries against BigQuery with cost guard",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s "SELECT count(*) FROM evenup-bi.dbt_prod.dim_matters"
  %(prog)s "SELECT * FROM evenup-bi.dbt_prod.dim_matters LIMIT 10" --max-gb 2.0
  cat query.sql | %(prog)s
        """
    )

    parser.add_argument(
        'sql',
        nargs='?',
        help='SQL query (or omit to read from stdin)'
    )
    parser.add_argument(
        '--max-gb',
        type=float,
        default=1.0,
        help='Maximum GB to allow (default: 1.0). Abort if dry-run exceeds this.'
    )

    return parser.parse_args()


def get_sql(sql_arg):
    """Get SQL from argument or stdin."""
    if sql_arg:
        return sql_arg.strip()

    if not sys.stdin.isatty():
        return sys.stdin.read().strip()

    raise ValueError("No SQL provided. Pass as argument or pipe via stdin.")


def validate_select_only(sql):
    """Reject non-SELECT queries."""
    stripped = sql.strip().upper()

    # Allow SELECT or WITH (for CTEs)
    if stripped.startswith('SELECT') or stripped.startswith('WITH'):
        return

    # Block dangerous operations
    forbidden = ['DELETE', 'INSERT', 'UPDATE', 'DROP', 'TRUNCATE', 'CREATE', 'MERGE', 'ALTER']
    for op in forbidden:
        if stripped.startswith(op):
            raise ValueError(
                f"🚨 QUERY REJECTED: {op} operations are not allowed.\n"
                f"Only SELECT queries are permitted."
            )

    raise ValueError(
        f"🚨 QUERY REJECTED: Query must start with SELECT or WITH.\n"
        f"Only SELECT queries are permitted."
    )


def dry_run(client, sql):
    """Estimate query cost via dry-run."""
    job_config = bigquery.QueryJobConfig(
        dry_run=True,
        use_query_cache=False
    )

    job = client.query(sql, job_config=job_config)

    bytes_processed = job.total_bytes_processed
    if bytes_processed is None:
        bytes_processed = 0

    return bytes_processed


def execute_query(client, sql):
    """Execute query and return results."""
    results = client.query(sql).result()

    rows = list(results)
    field_names = [field.name for field in results.schema]

    return rows, field_names


def write_csv(rows, field_names, output_path):
    """Write results to CSV file."""
    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=field_names)
        writer.writeheader()
        for row in rows:
            # Convert BigQuery row to dict
            writer.writerow({name: row[name] for name in field_names})


def format_bytes(bytes_val):
    """Format bytes to human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_val < 1024:
            return f"{bytes_val:.1f} {unit}"
        bytes_val /= 1024
    return f"{bytes_val:.1f} TB"


def main():
    args = parse_args()

    try:
        # Get SQL
        sql = get_sql(args.sql)

        # Validate (SELECT only)
        validate_select_only(sql)

        # Initialize BigQuery client — use user's OAuth token if available
        # (elevated access to sensitive datasets), fall back to app SA.
        project = os.environ.get('GOOGLE_CLOUD_PROJECT', 'evenup-bi')
        user_token = os.environ.get('GOOGLE_USER_ACCESS_TOKEN')
        if user_token:
            from google.oauth2.credentials import Credentials
            creds = Credentials(token=user_token)
            client = bigquery.Client(project=project, credentials=creds)
        else:
            client = bigquery.Client(project=project)

        # Dry-run to estimate cost
        bytes_estimate = dry_run(client, sql)
        max_bytes = args.max_gb * (1024**3)

        if bytes_estimate > max_bytes:
            print(
                f"🚨 QUERY TOO LARGE: estimated {bytes_estimate / (1024**3):.1f} GB "
                f"exceeds {args.max_gb:.1f} GB limit.",
                file=sys.stderr
            )
            print(
                "Add a more restrictive WHERE clause or reduce scope. "
                "Use --max-gb to override.",
                file=sys.stderr
            )
            sys.exit(1)

        # Execute query
        rows, field_names = execute_query(client, sql)

        # Write to CSV
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_id = f"{os.getpid()}_{uuid.uuid4().hex[:8]}"
        output_path = f"/tmp/bq_result_{timestamp}_{output_id}.csv"
        write_csv(rows, field_names, output_path)

        # Print summary (context-safe)
        print("✅ Query completed")
        print(f"Rows: {len(rows):,}")
        print(f"Bytes billed: {format_bytes(bytes_estimate)}")
        print(f"Columns: {', '.join(field_names)}")
        print(f"Results written to: {output_path}")

    except Exception as e:
        msg = str(e)
        print(f"Error: {msg}", file=sys.stderr)
        if "403" in msg or "Access Denied" in msg or "accessDenied" in msg:
            if not user_token:
                print(
                    "\n🔒 ACCESS DENIED: The app service account does not have "
                    "access to this dataset. The user can grant elevated access "
                    "by connecting their Google account on the Resources page.",
                    file=sys.stderr,
                )
        sys.exit(1)


if __name__ == "__main__":
    main()
