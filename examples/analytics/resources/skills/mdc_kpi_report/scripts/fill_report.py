#!/usr/bin/env python3
"""
fill_report.py — MDC KPI report template filler.

Reads Template 0 CSV (mart_missing_doc_check_product_usage_kpi), computes all metrics,
fills references/report_template.html, and writes mdc_report_YYYYMMDD.html.

Usage:
    python3 .claude/skills/mdc_kpi_report/scripts/fill_report.py \
        --kpis   /tmp/mdc_t0_YYYYMMDD.csv \
        --output /tmp/mdc_report_YYYYMMDD.html
"""

import argparse, csv, os
from datetime import date, datetime as _dt

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE  = os.path.join(SKILL_DIR, 'references', 'report_template.html')

ANOMALY_THRESHOLD = 0.10   # 10% — applies to P0/P1 metrics

# ─── CLI ─────────────────────────────────────────────────────────────────────
p = argparse.ArgumentParser(description='Fill MDC KPI HTML report template')
p.add_argument('--kpis',   required=True, help='Template 0 CSV path')
p.add_argument('--output', required=True, help='Output HTML path')
args = p.parse_args()

def load(path):
    if not path or not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))

kpis_raw = load(args.kpis)

# ─── DATE WINDOWS ─────────────────────────────────────────────────────────────
# Use positional logic: sort CSV rows by week_start, take last 8.
# This avoids a Monday/Tuesday mismatch — mart stores summary_date as Tuesdays
# (DATE_TRUNC(..., WEEK(MONDAY)) on a Tuesday returns the previous Monday,
#  but the mart itself uses a Tuesday anchor, so computed Monday dates never match).
kpis_sorted  = sorted(kpis_raw, key=lambda r: r['week_start'])[-8:]
ALL_8        = [r['week_start'] for r in kpis_sorted]
RECENT       = set(ALL_8[-2:])
PRIOR        = set(ALL_8[-6:-2])
RECENT_RANGE = f"{ALL_8[-2]} – {ALL_8[-1]}"
PRIOR_RANGE  = f"{ALL_8[-6] if len(ALL_8) >= 6 else ALL_8[0]} – {ALL_8[-3] if len(ALL_8) >= 3 else ALL_8[-1]}"
WK_LABELS    = [_dt.strptime(d, '%Y-%m-%d').strftime('%b %-d') for d in ALL_8]

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def pct_chg(a, b): return (a - b) / b * 100 if b else None
def arrow(p):
    if p is None or abs(p) <= 1: return '→', 'flat', '→'
    if p > 0: return '▲', 'up', f'+{p:.1f}%'
    return '▼', 'down', f'{p:.1f}%'
def fi(v):
    try: return f'{int(round(float(v))):,}'
    except: return '—'
def ff(v, d=1):
    try: return f'{float(v):.{d}f}'
    except: return '—'
def pct(v):
    try: return f'{float(v)*100:.1f}%'
    except: return '—'

# ─── INDEX DATA ───────────────────────────────────────────────────────────────
kpis = {}
for r in kpis_raw:
    kpis[r['week_start']] = r

FLAGGED_METRICS = []

# ─── SECTION 1: WEEKLY TREND ─────────────────────────────────────────────────
def build_weekly_headers():
    parts = []
    for i, lbl in enumerate(WK_LABELS):
        cls = ' class="wk-recent"' if ALL_8[i] in RECENT else ''
        parts.append(f'<th{cls}>{lbl}</th>')
    return '\n'.join(parts)

def weekly_row(label, key, fmt=fi, flag_key=None, flag_threshold=ANOMALY_THRESHOLD, priority='p1'):
    cells = []
    recent_vals, prior_vals = [], []
    for i, wk in enumerate(ALL_8):
        d = kpis.get(wk, {})
        raw = d.get(key)
        cls = ' class="num wk-recent"' if wk in RECENT else ' class="num"'
        try:
            val = float(raw)
            display = fmt(val)
        except (TypeError, ValueError):
            val = None
            display = '<span style="color:#ccc">—</span>'
        cells.append(f'<td{cls}>{display}</td>')
        if val is not None:
            if wk in RECENT: recent_vals.append(val)
            if wk in PRIOR:  prior_vals.append(val)

    r_avg = sum(recent_vals) / len(recent_vals) if recent_vals else None
    p_avg = sum(prior_vals)  / len(prior_vals)  if prior_vals  else None
    pc = pct_chg(r_avg, p_avg)
    _, cls_, pct_str = arrow(pc)
    if pc is not None and abs(pc) > flag_threshold * 100 and flag_key:
        FLAGGED_METRICS.append(f"{label}: {pct_str}")
    pri_html = f'<span class="{priority}">{priority.upper()}</span>'
    return f'<tr><td>{label}</td><td>{pri_html}</td>{"".join(cells)}</tr>'

WEEKLY_TREND_ROWS = '\n'.join([
    weekly_row('% MDC Runs with 1+ Modal Open (total)',    'pct_mdc_runs_viewed',          fmt=pct, flag_key='p0_total',   flag_threshold=0.10, priority='p0'),
    weekly_row('% MDC Runs with 1+ Modal Open (CI)',       'pct_ci_mdc_runs_viewed',        fmt=pct, flag_key='p0_ci',      flag_threshold=0.10, priority='p1'),
    weekly_row('% MDC Runs with 1+ Modal Open (non-CI)',   'pct_non_ci_mdc_runs_viewed',    fmt=pct, flag_key='p0_nci',     flag_threshold=0.10, priority='p1'),
    weekly_row('# Total MDC Runs',                         'num_total_runs',                fmt=fi,  flag_key='runs',       flag_threshold=0.10, priority='p1'),
    weekly_row('# MDC-enabled firms',                      'num_mdc_enabled_firms',         fmt=fi,  flag_key='enabled',    flag_threshold=0.10, priority='p1'),
    weekly_row('# Firms w/ 1+ MDC run',                   'num_firms_with_1_plus_mdc_run', fmt=fi,  flag_key='firms_1',    flag_threshold=0.10, priority='p1'),
    weekly_row('% enabled firms w/ 1+ MDC run',           'pct_firms_with_1_plus_mdc_run', fmt=pct, flag_key='pct_firms1', flag_threshold=0.10, priority='p1'),
    weekly_row('# Firms w/ 5+ MDC runs',                  'num_firms_with_5_plus_mdc_run', fmt=fi,  flag_key='firms_5',    flag_threshold=0.15, priority='p1'),
    weekly_row('% enabled firms w/ 5+ MDC runs',          'pct_firms_with_5_plus_mdc_run', fmt=pct, flag_key='pct_firms5', flag_threshold=0.15, priority='p1'),
    weekly_row('MDC runs / active firm',                   'mdc_runs_per_firm',             fmt=lambda v: ff(v, 1), flag_key='rpm', flag_threshold=0.15, priority='p1'),
    weekly_row('Mean TAT per run (hours)',                 'avg_turnaround_time',           fmt=lambda v: ff(v, 1), flag_key='tat', flag_threshold=0.20, priority='p1'),
    weekly_row('Mean issues per MDC run',                  'avg_issue_per_run',             fmt=lambda v: ff(v, 1), flag_key='issues', flag_threshold=0.15, priority='p1'),
    weekly_row('T7 returning users',                       'num_repeat_users',              fmt=fi,  flag_key='repeat_u',  flag_threshold=0.15, priority='p2'),
    weekly_row('% MDC runs by new users',                  'pct_mdc_runs_by_new_user',      fmt=pct, flag_key='new_usr',   flag_threshold=0.15, priority='p2'),
    weekly_row('% cases with dismissed issue',             'pct_cases_with_dismissed_issue',fmt=pct, flag_key='dismissed', flag_threshold=0.15, priority='p2'),
    weekly_row('% cases with resolved issue',              'pct_cases_with_resolved_issue', fmt=pct, flag_key='resolved',  flag_threshold=0.15, priority='p2'),
])

# ─── WEEKLY TREND INSIGHT ─────────────────────────────────────────────────────
def period_avg(key, cast=float):
    r = [cast(kpis[w][key]) for w in RECENT if kpis.get(w, {}).get(key)]
    p = [cast(kpis[w][key]) for w in PRIOR  if kpis.get(w, {}).get(key)]
    return (sum(r)/len(r) if r else None), (sum(p)/len(p) if p else None)

r_p0, p_p0 = period_avg('pct_mdc_runs_viewed')
r_runs, p_runs = period_avg('num_total_runs')
_, _, p0_str = arrow(pct_chg(r_p0, p_p0))
_, p0_dir, _  = arrow(pct_chg(r_p0, p_p0))

WEEKLY_TREND_INSIGHT = (
    f"P0 Modal Open Rate: <strong>{pct(r_p0)}</strong>/wk recent vs {pct(p_p0)}/wk prior "
    f"<span class='{p0_dir}'>{p0_str}</span>. "
    f"Total runs: {fi(r_runs)}/wk recent vs {fi(p_runs)}/wk prior."
)

# ─── SECTION 2: PERIOD COMPARISON (CI / Non-CI / Total) ──────────────────────
def period_row(label, key, segment_label, fmt, threshold=ANOMALY_THRESHOLD, priority='p1'):
    r_vals = [float(kpis[w][key]) for w in RECENT if kpis.get(w, {}).get(key)]
    p_vals = [float(kpis[w][key]) for w in PRIOR  if kpis.get(w, {}).get(key)]
    r_pw = sum(r_vals) / max(len(r_vals), 1)
    p_pw = sum(p_vals) / max(len(p_vals), 1)
    pc = pct_chg(r_pw, p_pw)
    sym, cls, pct_str = arrow(pc)
    if pc is not None and abs(pc) > threshold * 100:
        FLAGGED_METRICS.append(f"{label} ({segment_label}): {pct_str}")
    seg_badge = (
        '<span class="badge-seg1">CI</span>' if 'CI' in segment_label and 'non' not in segment_label.lower()
        else '<span class="badge-seg2">Non-CI</span>' if 'non' in segment_label.lower()
        else ''
    )
    pri_html = f'<span class="{priority}">{priority.upper()}</span>'
    return (
        f'<tr><td>{seg_badge} {segment_label} — {label}</td><td>{pri_html}</td>'
        f'<td class="num">{fmt(p_pw)}</td><td class="num">{fmt(r_pw)}</td>'
        f'<td class="num {cls}">{sym} {pct_str}</td></tr>'
    )

PERIOD_COMPARISON_ROWS = '\n'.join([
    period_row('% Runs with Modal Open',  'pct_mdc_runs_viewed',          'Total',   pct, threshold=0.10, priority='p0'),
    period_row('% Runs with Modal Open',  'pct_ci_mdc_runs_viewed',        'CI only', pct, threshold=0.10, priority='p1'),
    period_row('% Runs with Modal Open',  'pct_non_ci_mdc_runs_viewed',    'Non-CI',  pct, threshold=0.10, priority='p1'),
    period_row('# Total MDC Runs',        'num_total_runs',                'Total',   fi,  threshold=0.10, priority='p1'),
    period_row('# Runs (CI)',             'num_ci_runs',                   'CI only', fi,  threshold=0.10, priority='p1'),
    period_row('# Runs (non-CI)',         'num_non_ci_runs',               'Non-CI',  fi,  threshold=0.10, priority='p1'),
    period_row('% enabled firms w/ 1+ run', 'pct_firms_with_1_plus_mdc_run', 'Total', pct, threshold=0.10, priority='p1'),
    period_row('MDC runs / active firm',  'mdc_runs_per_firm',             'Total',   lambda v: ff(v, 1), threshold=0.15, priority='p1'),
])

# ─── SECTION 3: RUN BEHAVIOR ─────────────────────────────────────────────────
def behavior_row(label, key, fmt, threshold=0.15, priority='p2'):
    r_vals = [float(kpis[w][key]) for w in RECENT if kpis.get(w, {}).get(key)]
    p_vals = [float(kpis[w][key]) for w in PRIOR  if kpis.get(w, {}).get(key)]
    r_pw = sum(r_vals) / max(len(r_vals), 1)
    p_pw = sum(p_vals) / max(len(p_vals), 1)
    pc = pct_chg(r_pw, p_pw)
    sym, cls, pct_str = arrow(pc)
    if pc is not None and abs(pc) > threshold * 100:
        FLAGGED_METRICS.append(f"{label}: {pct_str}")
    pri_html = f'<span class="{priority}">{priority.upper()}</span>'
    return (
        f'<tr><td>{label}</td><td>{pri_html}</td>'
        f'<td class="num">{fmt(p_pw)}</td><td class="num">{fmt(r_pw)}</td>'
        f'<td class="num {cls}">{sym} {pct_str}</td></tr>'
    )

SECTION_3_ROWS = '\n'.join([
    behavior_row('Mean TAT per run (hours)',        'avg_turnaround_time',           lambda v: ff(v, 1), threshold=0.20, priority='p1'),
    behavior_row('Mean issues per MDC run',         'avg_issue_per_run',             lambda v: ff(v, 1), threshold=0.15, priority='p1'),
    behavior_row('T7 returning users',              'num_repeat_users',              fi,  threshold=0.15, priority='p2'),
    behavior_row('# MDC runs by new users',         'num_mdc_runs_by_new_user',      fi,  threshold=0.20, priority='p2'),
    behavior_row('# MDC runs by repeat users',      'num_mdc_runs_by_repeat_user',   fi,  threshold=0.15, priority='p2'),
    behavior_row('% MDC runs by new users',         'pct_mdc_runs_by_new_user',      pct, threshold=0.15, priority='p2'),
    behavior_row('% cases w/ dismissed issue',      'pct_cases_with_dismissed_issue',pct, threshold=0.15, priority='p2'),
    behavior_row('% cases w/ resolved issue',       'pct_cases_with_resolved_issue', pct, threshold=0.15, priority='p2'),
])

# Insight: repeat vs new user mix
r_repeat_pct, _ = period_avg('pct_mdc_runs_by_repeat_user')
r_tat, _        = period_avg('avg_turnaround_time')
SECTION_3_INSIGHT = (
    f"Repeat user run share: <strong>{pct(r_repeat_pct)}</strong> recent. "
    f"Mean TAT: <strong>{ff(r_tat, 1) if r_tat else '—'}h</strong> recent."
)

# ─── EXEC SUMMARY ─────────────────────────────────────────────────────────────
if FLAGGED_METRICS:
    exec_summary = (
        f"⚠️ {len(FLAGGED_METRICS)} metric(s) flagged: "
        f"{'; '.join(FLAGGED_METRICS[:3])}{'…' if len(FLAGGED_METRICS) > 3 else ''}."
    )
else:
    exec_summary = (
        f"✅ All metrics within normal range. "
        f"Modal open rate {pct(r_p0)}/wk ({p0_str}). Total runs {fi(r_runs)}/wk."
    )

# ─── FILL TEMPLATE ────────────────────────────────────────────────────────────
with open(TEMPLATE) as f:
    html = f.read()

replacements = {
    '{{PRODUCT_NAME}}':                    'Missing Docs Check (MDC)',
    '{{REPORT_DATE}}':                     date.today().strftime('%Y-%m-%d'),
    '{{RECENT_RANGE}}':                    RECENT_RANGE,
    '{{PRIOR_RANGE}}':                     PRIOR_RANGE,
    '{{EXEC_SUMMARY}}':                    exec_summary,
    '{{WEEKLY_TREND_HEADERS}}':            build_weekly_headers(),
    '{{WEEKLY_TREND_ROWS}}':               WEEKLY_TREND_ROWS,
    '{{WEEKLY_TREND_INSIGHT}}':            WEEKLY_TREND_INSIGHT,
    '{{PERIOD_COMPARISON_ROWS}}':          PERIOD_COMPARISON_ROWS,
    '{{SECTION_3_TITLE}}':                 'Run Behavior',
    '{{SECTION_3_NOTE}}':                  'TAT = mean hours from MDC run trigger to completion. Issues = distinct missing-doc flags per run. Repeat users = attorneys who ran MDC in multiple weeks.',
    '{{SECTION_3_ROWS}}':                  SECTION_3_ROWS,
    '{{SECTION_3_INSIGHT}}':               SECTION_3_INSIGHT,
    '{{DEEP_DIVE_SECTIONS}}':              "<div class='empty-dd'>No deep dives run yet.</div>",
    '{{QUERY_COUNT}}':                     '1',
    '{{QUERY_LOG}}':                       '<p class="note">Template 0 (WEEKLY_MDC_KPIS) executed against mart_missing_doc_check_product_usage_kpi.</p>',
    '{{OPS_MDC_NOTE}}':                    '<p class="note" style="color:#c2410c">⚠️ Ops-led MDC Tracking is not available in BigQuery.</p>',
}
for k, v in replacements.items():
    html = html.replace(k, v)

with open(args.output, 'w') as f:
    f.write(html)

print(f'Report saved to {args.output}')
if FLAGGED_METRICS:
    print(f'FLAGGED METRICS ({len(FLAGGED_METRICS)}):')
    for m in FLAGGED_METRICS:
        print(f'  • {m}')
else:
    print('No metrics flagged.')

print(f'\nNULL metrics (data not available):')
print('  • Ops-led MDC Tracking — not in BigQuery')
print(f'\nTo upload: invoke .claude/skills/report-uploader/SKILL.md')
print(f'  local_path: {args.output}')
print(f'  gcs_path:   generated/mdc_report_{date.today().strftime("%Y%m%d")}.html')
print(f'  display_name: MDC KPI Report — {date.today().strftime("%Y-%m-%d")}')
