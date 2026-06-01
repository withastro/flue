#!/usr/bin/env python3
"""
Metabase unified CLI — card creation (18 viz types) and research.

Usage:
    metabase-cli.py --help
    metabase-cli.py creation --help                          # shared args + all viz types
    metabase-cli.py creation <viz-type> --help              # JSON settings reference for that type
    metabase-cli.py creation bar --name "..." --query "..." --viz-settings '{...}'
    metabase-cli.py research --model stg_salesforce__accounts
    metabase-cli.py research --card 42 --sql
"""

import sys
import os
from pathlib import Path

# ── Venv bootstrap ────────────────────────────────────────────────────────────
venv_path = None
if os.environ.get('VIRTUAL_ENV'):
    venv_path = Path(os.environ['VIRTUAL_ENV'])
else:
    for _candidate in [
        Path.home() / '.virtualenvs' / 'dbt',
        Path(__file__).resolve().parent.parent.parent / '.venv',
        Path(__file__).resolve().parent.parent.parent / 'venv',
        Path('/opt/rstudio-connect/mnt/app/python/env'),
    ]:
        if _candidate.exists() and (_candidate / 'bin' / 'python').exists():
            venv_path = _candidate
            break

if venv_path:
    import site as _site
    _pkgs = list(venv_path.glob('lib/python*/site-packages'))
    if _pkgs:
        sys.path.insert(0, str(_pkgs[0]))
        os.environ['VIRTUAL_ENV'] = str(venv_path)

# ── Import metabase-creator (hyphen in filename requires importlib) ────────────
import importlib.util as _il

_spec = _il.spec_from_file_location(
    'metabase_creator',
    Path(__file__).resolve().parent / 'metabase-creator.py',
)
_creator = _il.module_from_spec(_spec)
_spec.loader.exec_module(_creator)

# ── Standard imports ──────────────────────────────────────────────────────────
import argparse
import json
import datetime
import decimal
from typing import Any, Dict, List, Optional

# ── Constants ─────────────────────────────────────────────────────────────────
BQ_PROJECT = 'evenup-bi'
BQ_DATASET = 'dbt_prod'
DEFAULT_COLLECTION_ID = 2260
DEFAULT_DATABASE_ID = 13371338

# ── Display type map (CLI viz-type → Metabase API display value) ───────────────
DISPLAY_MAP: Dict[str, str] = {
    'table':        'table',
    'bar':          'bar',
    'line':         'line',
    'area':         'area',
    'stacked-bar':  'bar',
    'stacked-area': 'area',
    'stacked-line': 'line',
}

VIZ_DESCRIPTIONS: Dict[str, str] = {
    'table':        'Tabular results (default)',
    'bar':          'Bar chart — categorical comparisons',
    'line':         'Line chart — trends over time',
    'area':         'Area chart — filled trend lines',
    'stacked-bar':  'Stacked bar chart (stack_type=stacked auto-applied)',
    'stacked-area': 'Stacked area chart (stack_type=stacked auto-applied)',
    'stacked-line': 'Stacked line chart (stack_type=stacked auto-applied)',
}

# ── Per-type --viz-settings documentation ─────────────────────────────────────
# Each value is shown verbatim in 'creation <type> --help'.
VIZ_SETTINGS_HELP: Dict[str, str] = {

    'table': """\
--viz-settings JSON keys:
  "table.columns"          array   Show/hide columns:
                                   [{"name": "col", "enabled": true}, ...]
  "table.pivot_column"     string  Column to pivot rows → columns
  "table.cell_column"      string  Column used as cell values in pivot

Example (hide a column):
  --viz-settings '{
    "table.columns": [
      {"name": "id",         "enabled": false},
      {"name": "firm_name",  "enabled": true},
      {"name": "created_at", "enabled": true}
    ]
  }'""",

    'bar': """\
--viz-settings JSON keys:
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  "stacked" | "normalized" (100%)
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.y_axis.scale"             string  "linear" | "power" | "log"
  "graph.y_axis.min"               number  Y-axis minimum value
  "graph.y_axis.auto_range"        bool    Unpin Y-axis from zero
  "graph.show_trendline"           bool    Fit a trend line
  "graph.show_values"              bool    Show values on bars
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series overrides:
                                   {"series_name": {"color": "#hex", "title": "..."}}
  "goal.value"                     number  Horizontal goal line
  "goal.label"                     string  Goal line label

Example (stacked bar, time x-axis):
  --viz-settings '{
    "graph.dimensions": ["month", "region"],
    "graph.metrics":    ["revenue"],
    "stackable.stack_type": "stacked",
    "graph.x_axis.scale": "timeseries",
    "graph.y_axis.min": 0
  }'""",

    'line': """\
--viz-settings JSON keys:
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  "stacked" | "normalized" (100%)
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.y_axis.scale"             string  "linear" | "power" | "log"
  "graph.y_axis.min"               number  Y-axis minimum value
  "graph.y_axis.auto_range"        bool    Unpin Y-axis from zero
  "graph.show_trendline"           bool    Fit a trend line
  "graph.show_values"              bool    Show values on points
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series overrides:
                                   {"series_name": {"color": "#hex", "title": "..."}}
  "goal.value"                     number  Horizontal goal line

Example (multi-metric time series):
  --viz-settings '{
    "graph.dimensions": ["date"],
    "graph.metrics":    ["arr", "mrr"],
    "graph.x_axis.scale": "timeseries",
    "graph.show_trendline": true
  }'""",

    'area': """\
--viz-settings JSON keys:
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  "stacked" | "normalized" (100%)
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.y_axis.scale"             string  "linear" | "power" | "log"
  "graph.y_axis.min"               number  Y-axis minimum value
  "graph.y_axis.auto_range"        bool    Unpin Y-axis from zero
  "graph.show_values"              bool    Show values on points
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series overrides

Example (100% stacked area):
  --viz-settings '{
    "graph.dimensions": ["month", "product"],
    "graph.metrics":    ["revenue"],
    "stackable.stack_type": "normalized",
    "graph.x_axis.scale": "timeseries"
  }'""",

    'stacked-bar': """\
stacked-bar auto-applies: "stackable.stack_type": "stacked"

--viz-settings JSON keys (same as bar, stack_type pre-set):
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  Override: "normalized" for 100%
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.y_axis.scale"             string  "linear" | "power" | "log"
  "graph.y_axis.min"               number  Y-axis minimum value
  "graph.show_values"              bool    Show values on bars
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series color/title overrides
  "goal.value"                     number  Horizontal goal line

Example:
  --viz-settings '{
    "graph.dimensions": ["month", "stage"],
    "graph.metrics":    ["deal_count"],
    "graph.x_axis.scale": "timeseries"
  }'""",

    'stacked-area': """\
stacked-area auto-applies: "stackable.stack_type": "stacked"

--viz-settings JSON keys (same as area, stack_type pre-set):
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  Override: "normalized" for 100%
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.show_values"              bool    Show values on points
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series color/title overrides

Example:
  --viz-settings '{
    "graph.dimensions": ["date", "firm_type"],
    "graph.metrics":    ["case_count"],
    "graph.x_axis.scale": "timeseries"
  }'""",

    'stacked-line': """\
stacked-line auto-applies: "stackable.stack_type": "stacked"

--viz-settings JSON keys (same as line, stack_type pre-set):
  "graph.dimensions"               array   X-axis / grouping columns
  "graph.metrics"                  array   Y-axis metric columns
  "stackable.stack_type"           string  Override: "normalized" for 100%
  "graph.x_axis.scale"             string  "timeseries" | "ordinal"
  "graph.show_values"              bool    Show values on points
  "line.missing_value_replacement" string  "zero" | "nothing" | "interpolate"
  "series_settings"                object  Per-series color/title overrides

Example:
  --viz-settings '{
    "graph.dimensions": ["week", "cohort"],
    "graph.metrics":    ["retention_rate"],
    "graph.x_axis.scale": "timeseries"
  }'""",

}


# ── Settings builder (simplified — named flags removed) ────────────────────────

def build_viz_settings(viz_type: str, viz_settings_json: Optional[str]) -> Dict[str, Any]:
    """Build visualization_settings dict from viz type and raw --viz-settings JSON."""
    settings: Dict[str, Any] = {}

    # Auto-apply stacking for stacked variants
    if viz_type in ('stacked-bar', 'stacked-area', 'stacked-line'):
        settings['stackable.stack_type'] = 'stacked'

    if viz_settings_json:
        try:
            settings.update(json.loads(viz_settings_json))
        except json.JSONDecodeError as e:
            print(f"WARNING: --viz-settings parse error: {e}", file=sys.stderr)

    return settings


# ── Parser ─────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:

    # ── Top-level ──────────────────────────────────────────────────────────────
    parser = argparse.ArgumentParser(
        prog='metabase-cli.py',
        description='Metabase CLI — create cards (18 viz types) or research model/card usage.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands:
  creation   Create a Metabase card  (run 'creation --help' for args + viz types)
  research   Look up Metabase cards by dbt model or card ID/name (outputs JSON)
        """,
    )
    top = parser.add_subparsers(dest='command', required=True)

    # ── creation ──────────────────────────────────────────────────────────────
    creation = top.add_parser(
        'creation',
        help='Create a Metabase card',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=f"""\
Create a Metabase card. Run 'creation <viz-type> --help' for --viz-settings JSON reference.

Arguments (apply to all viz types):
  --name NAME            Card name (required)
  --query QUERY          SQL query, must start with SELECT or WITH (required)
  --description TEXT     Card description
  --collection-id N      Collection ID (default: {DEFAULT_COLLECTION_ID})
  --database-id N        Database ID (default: {DEFAULT_DATABASE_ID})
  --dashboard-id N       Pin card to this dashboard after creation
  --cache-ttl SECONDS    Cache query results for N seconds
  --viz-settings JSON    Type-specific visualization settings as JSON object
  --field-filters JSON   Map of {{var}} → Metabase field ID for dropdown filters
                         Example: '{{"firm_name": 485405}}'
                         Use [[AND {{var}}]] in SQL. Omitted vars get text input.

Viz types:
""" + '\n'.join(f'  {k:<14} {v}' for k, v in VIZ_DESCRIPTIONS.items()),
    )
    viz = creation.add_subparsers(dest='viz_type', required=True)

    # Register each viz type.
    # Shared args are added with help=SUPPRESS so they don't clutter viz-type --help.
    # The description for each parser is the --viz-settings JSON reference.
    for vtype, desc in VIZ_DESCRIPTIONS.items():
        settings_help = VIZ_SETTINGS_HELP.get(vtype, '(no viz-specific settings)')
        p = viz.add_parser(
            vtype,
            formatter_class=argparse.RawDescriptionHelpFormatter,
            help=desc,
            description=f'{vtype} — {desc}\n\n{settings_help}',
        )
        # Shared args — suppressed so they don't repeat in every viz-type --help
        p.add_argument('--name', required=True, help=argparse.SUPPRESS)
        p.add_argument('--query', required=True, help=argparse.SUPPRESS)
        p.add_argument('--description', help=argparse.SUPPRESS)
        p.add_argument('--collection-id', dest='collection_id', type=int,
                       default=DEFAULT_COLLECTION_ID, help=argparse.SUPPRESS)
        p.add_argument('--database-id', dest='database_id', type=int,
                       default=DEFAULT_DATABASE_ID, help=argparse.SUPPRESS)
        p.add_argument('--dashboard-id', dest='dashboard_id', type=int,
                       help=argparse.SUPPRESS)
        p.add_argument('--cache-ttl', dest='cache_ttl', type=int,
                       help=argparse.SUPPRESS)
        p.add_argument('--viz-settings', dest='viz_settings', metavar='JSON',
                       help='Visualization settings JSON (see examples above)')
        p.add_argument('--field-filters', dest='field_filters', metavar='JSON',
                       help='Map of {{var}} → Metabase field ID for dropdown filters. '
                            'Example: \'{"firm_name": 485405}\'. '
                            'Use [[AND {{var}}]] in SQL (not col = {{var}}). '
                            'Variables omitted here get a plain text input.')

    # ── research ──────────────────────────────────────────────────────────────
    research = top.add_parser(
        'research',
        help='Research Metabase cards by dbt model or card ID/name (outputs JSON)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="""
Look up Metabase card usage using BigQuery analytics tables. Output is JSON.

Lookup modes (use one):
  --model <name>     Find cards that reference a specific dbt model
  --card  <id|name>  Get metadata + model dependencies for a specific card
        """,
        epilog="""
Examples:
  # All cards using a dbt model (bookmarked first, then by view count)
  metabase-cli.py research --model stg_salesforce__accounts

  # Top 5 results, include native SQL
  metabase-cli.py research --model mart_revenue --top 5 --sql

  # Only bookmarked cards
  metabase-cli.py research --model dim_firms --ref-type bookmarked_card

  # Card metadata + dbt model dependencies by ID
  metabase-cli.py research --card 42

  # By name (case-insensitive), include SQL
  metabase-cli.py research --card "ARR by Segment" --sql
        """,
    )
    research.add_argument('--model', metavar='DBT_MODEL_NAME',
                          help='dbt model name to find Metabase cards for')
    research.add_argument('--card', metavar='ID_OR_NAME',
                          help='Card ID (integer) or name (string, case-insensitive)')
    research.add_argument('--top', type=int, metavar='N',
                          help='Limit to top N results (--model only)')
    research.add_argument('--sql', action='store_true',
                          help='Include native_query_sql in output')
    research.add_argument('--ref-type', dest='ref_type',
                          choices=['bookmarked_card', 'frequently_run_card'],
                          help='Filter by usage signal type (--model only)')

    return parser


# ── BQ helpers ─────────────────────────────────────────────────────────────────

def _bq_value_to_json(v: Any) -> Any:
    """Recursively convert BigQuery result values to JSON-serializable types."""
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, list):
        return [_bq_value_to_json(item) for item in v]
    # BigQuery Row / STRUCT — has .items()
    try:
        return {k: _bq_value_to_json(val) for k, val in v.items()}
    except AttributeError:
        pass
    return v


def _run_bq_query(sql: str, params: Optional[list] = None) -> List[Dict[str, Any]]:
    """Execute a parameterized BQ query. Returns list of dicts."""
    try:
        from google.cloud import bigquery
    except ImportError:
        print("ERROR: google-cloud-bigquery not installed. Run: pip install google-cloud-bigquery",
              file=sys.stderr)
        sys.exit(1)

    client = bigquery.Client(project=BQ_PROJECT)
    job_config = bigquery.QueryJobConfig(query_parameters=params or [])
    results = client.query(sql, job_config=job_config).result()
    return [
        {field.name: _bq_value_to_json(row[field.name]) for field in results.schema}
        for row in results
    ]


def _research_model(
    model_name: str,
    top_n: Optional[int],
    include_sql: bool,
    ref_type: Optional[str],
) -> List[Dict[str, Any]]:
    """Query mart_dbt_model_metabase_usage for cards referencing a dbt model."""
    try:
        from google.cloud import bigquery
    except ImportError:
        print("ERROR: google-cloud-bigquery not installed.", file=sys.stderr)
        sys.exit(1)

    params = [bigquery.ScalarQueryParameter('model_name', 'STRING', model_name)]
    ref_type_clause = ''
    if ref_type:
        ref_type_clause = 'AND ref_type = @ref_type'
        params.append(bigquery.ScalarQueryParameter('ref_type', 'STRING', ref_type))

    sql_col = ',\n    native_query_sql' if include_sql else ''
    limit_clause = f'LIMIT {top_n}' if top_n else ''

    sql = f"""
SELECT
    card_id,
    card_name,
    card_url,
    ref_type,
    view_count,
    bookmark_count,
    creator_email,
    primary_dashboard_name,
    last_used_at{sql_col}
FROM `{BQ_PROJECT}`.`{BQ_DATASET}`.`mart_dbt_model_metabase_usage`
WHERE dbt_model_name = @model_name
  {ref_type_clause}
ORDER BY
    CASE ref_type WHEN 'bookmarked_card' THEN 1 ELSE 2 END,
    view_count DESC NULLS LAST
{limit_clause}
""".strip()

    return _run_bq_query(sql, params)


def _research_card(card_ref: str, include_sql: bool) -> List[Dict[str, Any]]:
    """Query card metadata + model dependencies by card ID or name."""
    try:
        from google.cloud import bigquery
    except ImportError:
        print("ERROR: google-cloud-bigquery not installed.", file=sys.stderr)
        sys.exit(1)

    sql_col = ',\n    c.native_query_sql' if include_sql else ''

    if card_ref.strip().lstrip('-').isdigit():
        where_clause = 'WHERE c.card_id = @card_ref_int'
        params = [bigquery.ScalarQueryParameter('card_ref_int', 'INT64', int(card_ref))]
    else:
        where_clause = 'WHERE LOWER(c.card_name) = LOWER(@card_ref_str)'
        params = [bigquery.ScalarQueryParameter('card_ref_str', 'STRING', card_ref)]

    sql = f"""
SELECT
    c.card_id,
    c.card_name,
    c.card_description,
    c.card_display,
    c.card_url,
    c.creator_email,
    c.view_count,
    c.bookmark_count,
    c.primary_dashboard_name,
    c.last_used_at,
    c.created_at{sql_col},
    ARRAY_AGG(
        IF(d.dbt_model_name IS NULL, NULL,
            STRUCT(d.dbt_model_name, d.raw_table_reference, d.reference_count)
        ) IGNORE NULLS
        ORDER BY d.dbt_model_name
    ) AS model_dependencies
FROM `{BQ_PROJECT}`.`{BQ_DATASET}`.`int_metabase_cards_context` c
LEFT JOIN `{BQ_PROJECT}`.`{BQ_DATASET}`.`int_metabase_card_model_dependencies` d
    ON d.card_id = c.card_id
{where_clause}
GROUP BY
    c.card_id,
    c.card_name,
    c.card_description,
    c.card_display,
    c.card_url,
    c.creator_email,
    c.view_count,
    c.bookmark_count,
    c.primary_dashboard_name,
    c.last_used_at,
    c.created_at{', c.native_query_sql' if include_sql else ''}
""".strip()

    return _run_bq_query(sql, params)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    # ── creation ──────────────────────────────────────────────────────────────
    if args.command == 'creation':
        viz_type = args.viz_type
        viz_settings = build_viz_settings(viz_type, getattr(args, 'viz_settings', None))

        field_filters = None
        raw_ff = getattr(args, 'field_filters', None)
        if raw_ff:
            try:
                field_filters = json.loads(raw_ff)
            except json.JSONDecodeError as e:
                print(f"ERROR: --field-filters parse error: {e}", file=sys.stderr)
                return 1

        success, card_id, error_details = _creator.create_card(
            name=args.name,
            query=args.query,
            display=DISPLAY_MAP[viz_type],
            viz_settings=viz_settings,
            description=getattr(args, 'description', None),
            collection_id=args.collection_id,
            database_id=args.database_id,
            dashboard_id=getattr(args, 'dashboard_id', None),
            cache_ttl=getattr(args, 'cache_ttl', None),
            field_filters=field_filters,
        )

        if success:
            _creator.print_success(card_id)
            return 0
        else:
            _creator.print_error(error_details)
            return 1

    # ── research ──────────────────────────────────────────────────────────────
    if args.command == 'research':
        if not args.model and not args.card:
            print("ERROR: provide --model or --card", file=sys.stderr)
            return 1
        if args.model and args.card:
            print("ERROR: use --model or --card, not both", file=sys.stderr)
            return 1

        if args.model:
            rows = _research_model(
                model_name=args.model,
                top_n=getattr(args, 'top', None),
                include_sql=args.sql,
                ref_type=getattr(args, 'ref_type', None),
            )
        else:
            rows = _research_card(card_ref=args.card, include_sql=args.sql)

        print(json.dumps(rows, indent=2))
        return 0

    return 0


if __name__ == '__main__':
    sys.exit(main())
