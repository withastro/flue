#!/usr/bin/env python3
"""
Metabase card creation script with guardrails and validation.

Creates Metabase cards with robust error handling and automatic error correction.

Usage:
    # Simple table
    ./metabase.py --name "Firms Sample" \
      --query "SELECT * FROM evenup-bi.dbt_prod.dim_firms LIMIT 10"

    # Bar chart
    ./metabase.py --name "Firms by Type" \
      --query "SELECT firm_type, COUNT(*) FROM evenup-bi.dbt_prod.dim_firms GROUP BY 1" \
      --display bar

    # Stacked bar chart
    ./metabase.py --name "Employee Growth by Geography" \
      --query "SELECT month, geography, COUNT(*) FROM ..." \
      --display stacked-bar \
      --description "Monthly headcount trends"

    # Custom visualization settings
    ./metabase.py --name "Custom Chart" \
      --query "SELECT ..." \
      --display line \
      --viz-settings '{"graph.dimensions": ["date"], "graph.metrics": ["count"]}'
"""

import sys
import os
from pathlib import Path

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

import argparse
import json
import re
import uuid as uuid_module
from typing import Dict, Any, Tuple, Optional

try:
    import requests
except ImportError:
    print("ERROR: requests library not found", file=sys.stderr)
    print("Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


# Configuration
METABASE_URL = "https://metabase.evenup.law"
DEFAULT_COLLECTION_ID = 2260  # ad-hoc collection
DEFAULT_DATABASE_ID = 13371338  # BigQuery
MAX_RETRIES = 3

# Display type mappings
DISPLAY_MAP = {
    'table': 'table',
    'bar': 'bar',
    'line': 'line',
    'area': 'area',
    'stacked-bar': 'bar',
    'stacked-area': 'area',
    'stacked-line': 'line',
}

ALLOWED_DISPLAYS = list(DISPLAY_MAP.keys())


def validate_environment() -> str:
    """Check METABASE_API_KEY exists."""
    api_key = os.getenv("METABASE_API_KEY")
    if not api_key:
        print("ERROR: METABASE_API_KEY environment variable not set", file=sys.stderr)
        print("Set with: export METABASE_API_KEY='your-key-here'", file=sys.stderr)
        sys.exit(1)
    return api_key


def validate_sql(query: str) -> None:
    """Validate SQL query starts with SELECT or WITH (read-only queries)."""
    normalized = query.strip().upper()
    if not (normalized.startswith('SELECT') or normalized.startswith('WITH')):
        print("ERROR: Query must start with SELECT or WITH (read-only queries only)", file=sys.stderr)
        sys.exit(1)


def build_visualization_settings(display: str, viz_json: Optional[str] = None) -> Dict[str, Any]:
    """
    Generate visualization settings with optional user overrides.

    See README.md for comprehensive visualization_settings examples including:
    - Bar/line/area charts: graph.dimensions, graph.metrics
    - Stacked charts: stackable.stack_type, series_settings
    - Axis customization: graph.x_axis.scale, graph.y_axis.min/max

    For complex settings, reverse-engineer from existing cards:
      curl -H "x-api-key: $METABASE_API_KEY" \
        https://metabase.evenup.law/api/card/{id} | jq '.visualization_settings'
    """
    settings = {}

    # Apply stacking for stacked charts
    if display in ['stacked-bar', 'stacked-area', 'stacked-line']:
        settings['stackable.stack_type'] = 'stacked'

    # Apply user overrides if provided
    if viz_json:
        try:
            user_settings = json.loads(viz_json)
            settings.update(user_settings)
        except json.JSONDecodeError as e:
            print(f"WARNING: Could not parse --viz-settings: {e}", file=sys.stderr)
            print("Continuing with default settings", file=sys.stderr)

    return settings


def extract_template_tags(query: str, field_filters: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """
    Auto-detect {{variable_name}} patterns in SQL and build template-tags dict.

    Metabase requires template-tags to be populated for any {{variable}} used in
    a native SQL query — if template-tags is empty the query will not be saved.

    Two filter types:
    - type "text"      — plain text input box; variable is substituted as a string.
                         SQL: [[AND lower(col) LIKE lower(concat('%', {{var}}, '%'))]]
    - type "dimension" — field filter with dropdown/autocomplete + multi-select.
                         SQL: [[AND {{var}}]]   (Metabase generates the full condition)
                         Requires the Metabase field ID for the target column.

    Args:
        query:        The native SQL string.
        field_filters: Map of variable_name → field spec for dimension filters.
                       Any variable not listed here gets type "text".
                       Two formats accepted:
                         int  → {"firm_name": 485405}
                         dict → {"firm_name": {"field_id": 485405, "alias": "pu.firm_name",
                                               "widget_type": "string/="}}
                       The "alias" must be "table_alias.column" where table_alias matches
                       the AS alias on the FROM clause (e.g. FROM `...` AS pu → alias "pu.firm_name").
                       NEVER use the project-qualified path as an alias — BigQuery parses
                       hyphens in "evenup-bi" as subtraction, breaking the WHERE clause.

                       widget_type controls the filter UI (default: "string/="):
                         "string/="          Dropdown, multi-select (string columns)
                         "string/contains"   Text input, substring match
                         "number/="          Number input, exact match
                         "number/between"    Two inputs, numeric range
                         "date/single"       Date picker, single date
                         "date/range"        Two date pickers, date range
                         "date/relative"     Preset selector ("Last 7 days", etc.)
                         "date/all-options"  Full date filter UI (all of the above)
                         "category"          Dropdown for low-cardinality columns
    """
    field_filters = field_filters or {}
    variable_names = set(re.findall(r'\{\{(\w+)\}\}', query))
    template_tags = {}
    for var_name in variable_names:
        display_name = var_name.replace('_', ' ').title()
        tag_id = str(uuid_module.uuid4())
        if var_name in field_filters:
            # field_filters values can be int (field_id only) or dict
            # {"field_id": int, "alias": "table.col"}.
            # alias is required when SQL references tables as dbt_prod.table (no project
            # prefix) — Metabase uses it to generate the correct column reference in the
            # WHERE clause. Without it, Metabase may emit a reference BigQuery can't resolve.
            ff_entry = field_filters[var_name]
            if isinstance(ff_entry, dict):
                field_id = ff_entry['field_id']
                alias = ff_entry.get('alias')
                widget_type = ff_entry.get('widget_type', 'string/=')
            else:
                field_id = ff_entry
                alias = None
                widget_type = 'string/='
            tag = {
                'id': tag_id,
                'name': var_name,
                'display-name': display_name,
                'type': 'dimension',
                'widget-type': widget_type,
                'dimension': ['field', field_id, None],
            }
            if alias:
                tag['alias'] = alias
            template_tags[var_name] = tag
        else:
            template_tags[var_name] = {
                'id': tag_id,
                'name': var_name,
                'display-name': display_name,
                'type': 'text',
                'required': False,
                'default': None,
            }
    return template_tags


def build_payload(name: str, query: str, display: str,
                 description: Optional[str] = None,
                 collection_id: int = DEFAULT_COLLECTION_ID,
                 database_id: int = DEFAULT_DATABASE_ID,
                 viz_settings: Optional[Dict[str, Any]] = None,
                 dashboard_id: Optional[int] = None,
                 cache_ttl: Optional[int] = None,
                 field_filters: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Construct API payload dict."""
    payload = {
        "name": name,
        "collection_id": collection_id,
        "display": display,
        "dataset_query": {
            "database": database_id,
            "type": "native",
            "native": {
                "query": query,
                "template-tags": extract_template_tags(query, field_filters)
            }
        },
        "visualization_settings": viz_settings or {}
    }

    if description:
        payload["description"] = description
    if dashboard_id:
        payload["dashboard_id"] = dashboard_id
    if cache_ttl:
        payload["cache_ttl"] = cache_ttl

    return payload


def lookup_field_id(table_name: str, column_name: str, api_key: str) -> Optional[int]:
    """
    Look up the Metabase field ID for a given table+column.

    Searches all tables whose name matches table_name (case-insensitive).
    Returns the field ID if found, None otherwise.
    """
    try:
        resp = requests.get(f"{METABASE_URL}/api/table", headers={"x-api-key": api_key})
        if resp.status_code != 200:
            return None
        tables = [t for t in resp.json() if t.get('name', '').lower() == table_name.lower()]
        if not tables:
            return None
        table_id = tables[0]['id']
        resp2 = requests.get(
            f"{METABASE_URL}/api/table/{table_id}/query_metadata",
            headers={"x-api-key": api_key}
        )
        if resp2.status_code != 200:
            return None
        for field in resp2.json().get('fields', []):
            if field.get('name', '').lower() == column_name.lower():
                return field['id']
    except Exception:
        pass
    return None


def _post_card(payload: Dict[str, Any], api_key: str) -> Tuple[bool, Optional[int], Optional[Dict]]:
    """
    POST to Metabase API.

    Returns:
        (True, card_id, None) on success
        (False, None, error_details) on failure
    """
    headers = {"x-api-key": api_key}
    url = f"{METABASE_URL}/api/card"

    try:
        response = requests.post(url, json=payload, headers=headers)

        if response.status_code == 200:
            card_data = response.json()
            card_id = card_data.get('id')
            return True, card_id, None
        else:
            error_details = {
                'status_code': response.status_code,
                'response': response.text,
                'json': None
            }

            try:
                error_details['json'] = response.json()
            except:
                pass

            return False, None, error_details

    except requests.exceptions.RequestException as e:
        error_details = {
            'status_code': None,
            'response': str(e),
            'json': None
        }
        return False, None, error_details


def try_fix_error(error_details: Dict, payload: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Attempt to fix payload based on error.

    Returns:
        (fixed: bool, fix_description: str)
    """
    status_code = error_details.get('status_code')
    error_json = error_details.get('json')

    # Unfixable errors
    if status_code in [401, 403]:
        return False, "Authentication/permission error (unfixable)"

    # Extract error message
    error_message = ""
    if error_json and isinstance(error_json, dict):
        error_message = error_json.get('message', '').lower()

    # Fix column reference errors
    if 'column' in error_message and 'not found' in error_message:
        viz_settings = payload.get('visualization_settings', {})
        column_keys = ['table.pivot_column', 'table.cell_column', 'graph.dimensions', 'graph.metrics']

        removed = []
        for key in column_keys:
            if key in viz_settings:
                del viz_settings[key]
                removed.append(key)

        if removed:
            payload['visualization_settings'] = viz_settings
            return True, f"Removed column references: {', '.join(removed)}"

    # Fix visualization type errors
    if 'visualization' in error_message and payload['display'] != 'table':
        old_display = payload['display']
        payload['display'] = 'table'
        payload['visualization_settings'] = {}
        return True, f"Changed display from {old_display} to table"

    # Generic fix: clear visualization settings
    if payload.get('visualization_settings'):
        payload['visualization_settings'] = {}
        return True, "Cleared all visualization settings"

    return False, "No fix available"


def _create_card_with_retry(payload: Dict[str, Any], api_key: str, max_retries: int = MAX_RETRIES) -> Tuple[bool, Optional[int], Optional[Dict]]:
    """Create card with automatic error correction and retry."""
    for attempt in range(max_retries):
        success, card_id, error_details = _post_card(payload, api_key)

        if success:
            if attempt > 0:
                print(f"Success after {attempt + 1} attempt(s)", file=sys.stderr)
            return True, card_id, None

        # Try to fix error
        fixed, fix_description = try_fix_error(error_details, payload)

        if not fixed:
            return False, None, error_details

        # Log retry
        if attempt < max_retries - 1:
            print(f"Retry {attempt + 2}/{max_retries}: {fix_description}", file=sys.stderr)

    return False, None, error_details


def create_card(
    name: str,
    query: str,
    display: str,
    viz_settings: Optional[Dict[str, Any]] = None,
    description: Optional[str] = None,
    collection_id: int = DEFAULT_COLLECTION_ID,
    database_id: int = DEFAULT_DATABASE_ID,
    dashboard_id: Optional[int] = None,
    cache_ttl: Optional[int] = None,
    field_filters: Optional[Dict[str, int]] = None,
) -> Tuple[bool, Optional[int], Optional[Dict]]:
    """
    Public callable: create a Metabase card.

    Args:
        name: Card display name.
        query: SQL query (must start with SELECT or WITH).
        display: Metabase display type string (e.g. 'bar', 'table', 'scalar').
        viz_settings: visualization_settings dict (already built by caller).
        description: Optional card description.
        collection_id: Metabase collection ID.
        database_id: Metabase database ID.
        dashboard_id: Pin to this dashboard after creation.
        cache_ttl: Cache query results for this many seconds.
        field_filters: Map of {{variable_name}} → Metabase field ID for dimension
                       (dropdown) filters. Variables not listed use type "text".
                       Example: {"firm_name": 485405}

    Returns:
        (True, card_id, None) on success
        (False, None, error_details) on failure
    """
    api_key = validate_environment()
    validate_sql(query)
    payload = build_payload(
        name=name,
        query=query,
        display=display,
        description=description,
        collection_id=collection_id,
        database_id=database_id,
        viz_settings=viz_settings,
        dashboard_id=dashboard_id,
        cache_ttl=cache_ttl,
        field_filters=field_filters,
    )
    return _create_card_with_retry(payload, api_key)


def print_success(card_id: int) -> None:
    """Print success message with card URL."""
    card_url = f"{METABASE_URL}/question/{card_id}"
    print(f"SUCCESS: Card created (ID: {card_id})")
    print(f"URL: {card_url}")


def print_error(error_details: Dict) -> None:
    """Print formatted error message."""
    status_code = error_details.get('status_code')
    error_json = error_details.get('json')
    response_text = error_details.get('response', '')

    print("ERROR: Card creation failed", file=sys.stderr)

    if status_code == 401:
        print("Reason: Authentication failed", file=sys.stderr)
        print("Check: METABASE_API_KEY environment variable", file=sys.stderr)
    elif status_code == 403:
        print("Reason: Permission denied", file=sys.stderr)
        print(f"Check: Collection ID {DEFAULT_COLLECTION_ID} and Database ID {DEFAULT_DATABASE_ID}", file=sys.stderr)
    elif error_json and isinstance(error_json, dict):
        message = error_json.get('message', '')
        if message:
            print(f"Reason: {message}", file=sys.stderr)
        errors = error_json.get('errors')
        if errors:
            print(f"Details: {json.dumps(errors, indent=2)}", file=sys.stderr)
    elif status_code:
        print(f"Status: {status_code}", file=sys.stderr)
        print(f"Response: {response_text[:500]}", file=sys.stderr)
    else:
        print(f"Details: {response_text[:500]}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Create Metabase cards with validation and error handling",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Simple table
  %(prog)s --name "Firms Sample" \\
    --query "SELECT * FROM evenup-bi.dbt_prod.dim_firms LIMIT 10"

  # Bar chart
  %(prog)s --name "Firms by Type" \\
    --query "SELECT firm_type, COUNT(*) FROM evenup-bi.dbt_prod.dim_firms GROUP BY 1" \\
    --display bar

  # Stacked bar chart
  %(prog)s --name "Employee Growth" \\
    --query "SELECT month, geography, COUNT(*) FROM ..." \\
    --display stacked-bar \\
    --description "Monthly headcount trends"
        """
    )

    parser.add_argument('--name', required=True, help='Card name')
    parser.add_argument('--query', required=True, help='SQL query')
    parser.add_argument('--description', help='Card description')
    parser.add_argument('--display',
                       choices=ALLOWED_DISPLAYS,
                       default='table',
                       help='Visualization type (default: table)')
    parser.add_argument('--collection-id',
                       type=int,
                       default=DEFAULT_COLLECTION_ID,
                       help=f'Collection ID (default: {DEFAULT_COLLECTION_ID})')
    parser.add_argument('--database-id',
                       type=int,
                       default=DEFAULT_DATABASE_ID,
                       help=f'Database ID (default: {DEFAULT_DATABASE_ID})')
    parser.add_argument('--viz-settings',
                       help='Custom visualization settings as JSON string')
    parser.add_argument(
        '--field-filters',
        help=(
            'JSON map of {{variable_name}} → Metabase field ID for dimension (dropdown) filters. '
            'Example: \'{"firm_name": 485405}\'. '
            'To find a field ID: GET /api/table/<table_id>/query_metadata and inspect .fields[].id. '
            'Variables not listed here default to type "text" (plain text input).'
        )
    )

    args = parser.parse_args()

    # Parse field filters if provided
    field_filters = None
    if args.field_filters:
        try:
            field_filters = json.loads(args.field_filters)
        except json.JSONDecodeError as e:
            print(f"ERROR: Could not parse --field-filters: {e}", file=sys.stderr)
            return 1

    # Build viz settings (handles stacking, user overrides)
    viz_settings = build_visualization_settings(args.display, args.viz_settings)

    # Create card (validates API key and SQL internally)
    success, card_id, error_details = create_card(
        name=args.name,
        query=args.query,
        display=DISPLAY_MAP[args.display],
        viz_settings=viz_settings,
        description=args.description,
        collection_id=args.collection_id,
        database_id=args.database_id,
        field_filters=field_filters,
    )

    if success:
        print_success(card_id)
        return 0
    else:
        print_error(error_details)
        return 1


if __name__ == "__main__":
    sys.exit(main())
