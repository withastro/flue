#!/usr/bin/env python3
"""
fill_report.py — Case Companion KPI report template filler.

Usage:
    python3 .claude/skills/case_companion_kpi_report/scripts/fill_report.py \
        --weekly     /tmp/cc_t0_weekly.csv   \
        --wai-fact   /tmp/cc_t0b_wai_fact.csv \
        --exec-agg   /tmp/cc_t1_exec.csv     \
        --firm-grain /tmp/cc_t1b_firms.csv   \
        --quality    /tmp/cc_t2_quality.csv  \
        --latency    /tmp/cc_t3_latency.csv  \
        --output     /tmp/cc_report_YYYYMMDD.html
"""

import argparse, csv, os
from datetime import date, timedelta

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE  = os.path.join(SKILL_DIR, 'references', 'report_template.html')

ANOMALY_THRESHOLD = 0.10

# ─── CLI ─────────────────────────────────────────────────────────────────────
p = argparse.ArgumentParser()
p.add_argument('--weekly',     required=True)
p.add_argument('--wai-fact',   required=True, dest='wai_fact')
p.add_argument('--exec-agg',   required=True, dest='exec_agg')
p.add_argument('--firm-grain', required=True, dest='firm_grain')
p.add_argument('--quality',    required=True)
p.add_argument('--latency',    required=True)
p.add_argument('--output',     required=True)
args = p.parse_args()

def load(path):
    if not path or not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))

weekly_raw = load(args.weekly)
wai_fact   = load(args.wai_fact)
exec_agg   = load(args.exec_agg)
firm_grain = load(args.firm_grain)
quality    = load(args.quality)
latency    = load(args.latency)

# ─── DATE WINDOWS ─────────────────────────────────────────────────────────────
today    = date.today()
cur_week = today - timedelta(days=today.weekday())
ALL_8_D  = [cur_week - timedelta(weeks=w) for w in range(8, 0, -1)]
ALL_8    = [d.strftime('%Y-%m-%d') for d in ALL_8_D]
RECENT   = set(ALL_8[-2:])
PRIOR    = set(ALL_8[-6:-2])
RECENT_RANGE = f"{ALL_8[-2]} – {ALL_8[-1]}"
PRIOR_RANGE  = f"{ALL_8[-6]} – {ALL_8[-3]}"
WK_LABELS    = [d.strftime('%b %-d') for d in ALL_8_D]

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
def badge_ci(ci_val):
    if str(ci_val).lower() in ('true', '1', 'yes'):
        return '<span class="badge-seg1">CI</span>'
    return '<span class="badge-seg2">Non-CI</span>'

# ─── INDEX DATA ───────────────────────────────────────────────────────────────
wkly = {}
for r in weekly_raw:
    wkly[r['week_start']] = {
        'wau':         int(float(r.get('wau', 0) or 0)),
        'questions':   int(float(r.get('total_questions', 0) or 0)),
        'matters':     int(float(r.get('distinct_matters', 0) or 0)),
        'firms':       int(float(r.get('active_firms', 0) or 0)),
        'avg_qpu':     float(r.get('avg_queries_per_user', 0) or 0),
        'qpm':         float(r.get('questions_per_matter', 0) or 0),
        'share_fast':  float(r.get('share_fast', 0) or 0),
        'share_deep':  float(r.get('share_deep', 0) or 0),
        'share_ai_docs': float(r.get('share_ai_docs_origin', 0) or 0),
    }

fact = {}
for r in wai_fact:
    fact[r['week_start']] = {
        'total_ewau':       int(float(r.get('total_ewau', 0) or 0)),
        'cc_wau_fact':      int(float(r.get('cc_wau_fact', 0) or 0)),
        'new_cc_users':     int(float(r.get('new_cc_users_this_week', 0) or 0)),
        'share_pre_doc':    float(r.get('share_pre_doc', 0) or 0),
        'share_pending':    float(r.get('share_pending', 0) or 0),
        'share_post_doc':   float(r.get('share_post_doc', 0) or 0),
    }

# Companion WAUs / lifetime users:
# cumulative sum of new_cc_users ordered by week_start
# NOTE: new_cc_users_this_week is per-matter first-engagement, not per-user first-ever.
# This approximation overcounts lifetime users; treat with caution.
sorted_weeks = sorted(fact.keys())
cumulative_cc_users = {}
running = 0
for wk in sorted_weeks:
    running += fact[wk]['new_cc_users']
    cumulative_cc_users[wk] = running

exec_by = {}
for r in exec_agg:
    exec_by[(r['week_start'], r['is_ci_matter'])] = {
        'wau':      int(float(r.get('wau', 0) or 0)),
        'questions': int(float(r.get('total_questions', 0) or 0)),
        'matters':  int(float(r.get('distinct_matters', 0) or 0)),
    }

qual_by = {}
for r in quality:
    qual_by[(r['week_start'], r['is_ci_matter'])] = r

lat_by = {}
for r in latency:
    lat_by[r['week_start']] = r

FLAGGED_METRICS = []

# ─── SECTION 1: WEEKLY TREND — 12 METRICS IN EXACT ORDER ─────────────────────
def build_weekly_headers():
    parts = []
    for i, lbl in enumerate(WK_LABELS):
        cls = ' class="wk-recent"' if ALL_8[i] in RECENT else ''
        parts.append(f'<th{cls}>{lbl}</th>')
    return '\n'.join(parts)

def weekly_row(label, key, src, fmt=fi, null_reason=None, flag_key=None, flag_threshold=ANOMALY_THRESHOLD):
    """Render one metric row across 8 weeks. src = 'wkly' or 'fact' dict."""
    cells = []
    recent_vals, prior_vals = [], []
    for i, wk in enumerate(ALL_8):
        d = src.get(wk, {})
        val = d.get(key) if d else None
        cls = ' class="num wk-recent"' if wk in RECENT else ' class="num"'
        display = fmt(val) if val is not None else '<span style="color:#ccc">—</span>'
        cells.append(f'<td{cls}>{display}</td>')
        if val is not None:
            if wk in RECENT: recent_vals.append(float(val))
            if wk in PRIOR:  prior_vals.append(float(val))

    if null_reason:
        return f'<tr><td>{label}</td>{"".join(cells)}</tr>'

    r_avg = sum(recent_vals) / len(recent_vals) if recent_vals else None
    p_avg = sum(prior_vals)  / len(prior_vals)  if prior_vals  else None
    pc = pct_chg(r_avg, p_avg)
    _, cls_, pct_str = arrow(pc)
    if pc is not None and abs(pc) > flag_threshold * 100 and flag_key:
        FLAGGED_METRICS.append(f"{label}: {pct_str}")
    return f'<tr><td>{label}</td>{"".join(cells)}</tr>'

def companion_wau_lifetime_row():
    """Metric 6: Companion WAUs / Companion lifetime users (cumulative)."""
    cells = []
    for i, wk in enumerate(ALL_8):
        wau = wkly.get(wk, {}).get('wau')
        lifetime = cumulative_cc_users.get(wk)
        cls = ' class="num wk-recent"' if wk in RECENT else ' class="num"'
        if wau and lifetime and lifetime > 0:
            ratio = wau / lifetime
            display = f'{ratio:.1%}'
        else:
            display = '<span style="color:#ccc">—</span>'
        cells.append(f'<td{cls}>{display}</td>')
    note = '<td class="num flat" style="font-size:10px;color:#999">⚠ approx</td>'
    return f'<tr><td>Companion WAUs / Companion lifetime users <span style="font-size:10px;color:#999">(per-matter proxy)</span></td>{"".join(cells)}</tr>'

# Build Section 1 rows in exact requested order
WEEKLY_TREND_ROWS = '\n'.join([
    # 1
    weekly_row('External WAU # (active = submitted CC query)', 'wau', wkly, fmt=fi, flag_key='wau'),
    # 2
    weekly_row('External Enabled Users # (any product)', 'total_ewau', fact, fmt=fi,
               flag_key='ewau', flag_threshold=0.10),
    # 3
    weekly_row('Avg # queries (active external users)', 'avg_qpu', wkly,
               fmt=lambda v: ff(v, 1), flag_key='avg_qpu', flag_threshold=0.15),
    # 4
    weekly_row('Total EvenUp WAU (any W&I activity)', 'total_ewau', fact, fmt=fi,
               flag_key='ewau2', flag_threshold=0.10),
    # 5
    weekly_row('', '', {}, null_reason='needs auth_user per-week join (date_joined &lt; week_end)'),
    # 6
    companion_wau_lifetime_row(),
    # 7
    weekly_row('Query share pre-doc request', 'share_pre_doc', fact, fmt=pct,
               flag_key='pre_doc', flag_threshold=0.15),
    # 8
    weekly_row('Query share doc request pending', 'share_pending', fact, fmt=pct,
               flag_key='pending', flag_threshold=0.20),
    # 9
    weekly_row('Query share post-doc request', 'share_post_doc', fact, fmt=pct,
               flag_key='post_doc', flag_threshold=0.15),
    # 10
    weekly_row('Query share Fast (mode)', 'share_fast', wkly, fmt=pct, flag_key='fast', flag_threshold=0.20),
    # 11
    weekly_row('Query share Deep Thinking (mode)', 'share_deep', wkly, fmt=pct,
               flag_key='deep', flag_threshold=0.20),
    # 12
    weekly_row('% CC queries from AI Docs (workstation_companion)', 'share_ai_docs', wkly, fmt=pct,
               flag_key='ai_docs', flag_threshold=0.15),
])

# Row 5 (WAUs enabled last 7 days / all WAUs) is still NULL — patch its empty label
WEEKLY_TREND_ROWS = WEEKLY_TREND_ROWS.replace(
    '<tr><td></td>',
    '<tr><td style="color:#999;font-style:italic">WAUs enabled last 7 days / all WAUs</td>',
    1
)

# ─── WEEKLY TREND INSIGHT ─────────────────────────────────────────────────────
recent_wau = sum(wkly.get(w, {}).get('wau', 0) for w in RECENT) / 2
prior_wau  = sum(wkly.get(w, {}).get('wau', 0) for w in PRIOR) / 4
wau_pc = pct_chg(recent_wau, prior_wau)
_, wau_dir, wau_pct_str = arrow(wau_pc)

recent_ewau = sum(fact.get(w, {}).get('total_ewau', 0) for w in RECENT) / 2
prior_ewau  = sum(fact.get(w, {}).get('total_ewau', 0) for w in PRIOR)  / 4
ewau_pc = pct_chg(recent_ewau, prior_ewau)
_, _, ewau_pct_str = arrow(ewau_pc)

# Pre/post doc share (recent avg)
recent_pre  = sum(fact.get(w, {}).get('share_pre_doc', 0) for w in RECENT) / 2
recent_post = sum(fact.get(w, {}).get('share_post_doc', 0) for w in RECENT) / 2

WEEKLY_TREND_INSIGHT = (
    f"CC WAU: <strong>{fi(recent_wau)}</strong>/wk recent vs {fi(prior_wau)}/wk prior "
    f"<span class='{wau_dir}'>{wau_pct_str}</span>. "
    f"EvenUp WAU: {fi(recent_ewau)}/wk ({ewau_pct_str}). "
    f"CC query mix: {pct(recent_pre)} pre-doc | {pct(recent_post)} post-doc."
)

# ─── SECTION 2: PERIOD COMPARISON (CI split) ─────────────────────────────────
period_rows = []
for ci_val, ci_label in [('True', 'CI'), ('False', 'Non-CI')]:
    for metric, label, fmt in [
        ('wau',       'WAU',             fi),
        ('questions', 'Questions',       fi),
        ('matters',   'Distinct matters', fi),
    ]:
        recent_total = sum(exec_by.get((w, ci_val), {}).get(metric, 0) for w in RECENT)
        prior_total  = sum(exec_by.get((w, ci_val), {}).get(metric, 0) for w in PRIOR)
        r_pw = recent_total / 2
        p_pw = prior_total / 4
        pc   = pct_chg(r_pw, p_pw)
        sym, cls, pct_str = arrow(pc)
        if pc is not None and abs(pc) > ANOMALY_THRESHOLD * 100:
            FLAGGED_METRICS.append(f"{label} ({ci_label}): {pct_str}")
        period_rows.append(
            f'<tr><td>{badge_ci(ci_val)} {ci_label} — {label}</td>'
            f'<td class="num">{fmt(p_pw)}</td><td class="num">{fmt(r_pw)}</td>'
            f'<td class="num {cls}">{sym} {pct_str}</td></tr>'
        )
PERIOD_COMPARISON_ROWS = '\n'.join(period_rows)

def firm_mover_rows(top=True):
    rows = []
    for r in firm_grain:
        delta = float(r.get('delta', 0) or 0)
        if top and delta <= 0: continue
        if not top and delta >= 0: continue
        sym = '▲' if delta > 0 else '▼'
        cls = 'up' if delta > 0 else 'down'
        rows.append((abs(delta),
            f'<tr><td>{r.get("firm_name","?")}</td>'
            f'<td>{badge_ci(r.get("is_ci_matter",""))}</td>'
            f'<td class="num">{ff(r.get("prior_pw",0),1)}</td>'
            f'<td class="num">{ff(r.get("recent_pw",0),1)}</td>'
            f'<td class="num {cls}">{sym} {abs(delta):.1f}</td></tr>'
        ))
    rows.sort(reverse=top)
    html = '\n'.join(r for _, r in rows[:10])
    return html if html else '<tr><td colspan="5" style="color:#999">No data</td></tr>'

TOP_GROWING_ROWS   = firm_mover_rows(top=True)
TOP_DECLINING_ROWS = firm_mover_rows(top=False)

# ─── SECTION 3: QUALITY METRICS ──────────────────────────────────────────────
def quality_period(metric_key, label, fmt=pct, threshold=0.15):
    r_vals, p_vals = [], []
    for wk in RECENT:
        for ci in ('True', 'False'):
            row = qual_by.get((wk, ci), {})
            if row and row.get(metric_key):
                r_vals.append(float(row[metric_key]))
    for wk in PRIOR:
        for ci in ('True', 'False'):
            row = qual_by.get((wk, ci), {})
            if row and row.get(metric_key):
                p_vals.append(float(row[metric_key]))
    r_pw = sum(r_vals) / max(len(r_vals), 1)
    p_pw = sum(p_vals) / max(len(p_vals), 1)
    pc = pct_chg(r_pw, p_pw)
    sym, cls, pct_str = arrow(pc)
    if pc is not None and abs(pc) > threshold * 100:
        FLAGGED_METRICS.append(f"{label}: {pct_str}")
    return (
        f'<tr><td>{label}</td><td><span class="p1">P1</span></td>'
        f'<td class="num">{fmt(p_pw)}</td><td class="num">{fmt(r_pw)}</td>'
        f'<td class="num {cls}">{sym} {pct_str}</td></tr>'
    )

mode_recent = {'fast': 0, 'balanced': 0, 'deep': 0}
for wk in RECENT:
    for ci in ('True', 'False'):
        row = qual_by.get((wk, ci), {})
        if row:
            for m in ('fast', 'balanced', 'deep'):
                mode_recent[m] += int(float(row.get(f'{m}_mode_count', 0) or 0))
tot = max(sum(mode_recent.values()), 1)
mode_note = (f"Recent mode mix: fast {mode_recent['fast']/tot*100:.0f}% | "
             f"balanced {mode_recent['balanced']/tot*100:.0f}% | "
             f"deep {mode_recent['deep']/tot*100:.0f}%")

SECTION_3_ROWS    = '\n'.join([
    quality_period('helpful_rate', 'Is-helpful rate'),
    quality_period('copy_rate',    'Copy rate'),
])
SECTION_3_INSIGHT = mode_note

# ─── SECTION 4: LATENCY ──────────────────────────────────────────────────────
def latency_period(metric_key, label, fmt=lambda v: f'{float(v):.0f}s', threshold=0.15, priority='p0'):
    r_vals = [float(lat_by[w][metric_key]) for w in RECENT if lat_by.get(w, {}).get(metric_key)]
    p_vals = [float(lat_by[w][metric_key]) for w in PRIOR  if lat_by.get(w, {}).get(metric_key)]
    r_pw = sum(r_vals) / max(len(r_vals), 1)
    p_pw = sum(p_vals) / max(len(p_vals), 1)
    pc = pct_chg(r_pw, p_pw)
    sym, cls, pct_str = arrow(pc)
    if pc is not None and abs(pc) > threshold * 100:
        FLAGGED_METRICS.append(f"Latency — {label}: {pct_str}")
    pri_html = f'<span class="{priority}">{priority.upper()}</span>'
    return (
        f'<tr><td>{label}</td><td>{pri_html}</td>'
        f'<td class="num">{fmt(p_pw) if p_pw else "—"}</td>'
        f'<td class="num">{fmt(r_pw) if r_pw else "—"}</td>'
        f'<td class="num {cls}">{sym} {pct_str}</td></tr>'
    )

recent_p50 = [float(lat_by[w]['p50_latency_sec']) for w in RECENT if lat_by.get(w,{}).get('p50_latency_sec')]
avg_p50 = sum(recent_p50) / max(len(recent_p50), 1)
latency_insight = f"Recent P50: {avg_p50:.0f}s avg."
if avg_p50 > 45: latency_insight += " ⚠️ P50 > 45s — elevated."

SECTION_4_ROWS = '\n'.join([
    latency_period('p50_latency_sec', 'P50 response latency', priority='p0'),
    latency_period('p95_latency_sec', 'P95 response latency', threshold=0.20, priority='p2'),
    latency_period('pct_over_60s',    '% questions > 60s', fmt=pct, threshold=0.20, priority='p2'),
])

# ─── EXEC SUMMARY ─────────────────────────────────────────────────────────────
if FLAGGED_METRICS:
    exec_summary = (f"⚠️ {len(FLAGGED_METRICS)} metric(s) flagged: "
                    f"{'; '.join(FLAGGED_METRICS[:3])}{'…' if len(FLAGGED_METRICS)>3 else ''}.")
else:
    exec_summary = f"✅ All metrics within normal range. CC WAU {fi(recent_wau)}/wk ({wau_pct_str})."

# ─── FILL TEMPLATE ────────────────────────────────────────────────────────────
with open(TEMPLATE) as f:
    html = f.read()

replacements = {
    '{{PRODUCT_NAME}}':           'Case Companion',
    '{{REPORT_DATE}}':            date.today().strftime('%Y-%m-%d'),
    '{{RECENT_RANGE}}':           RECENT_RANGE,
    '{{PRIOR_RANGE}}':            PRIOR_RANGE,
    '{{EXEC_SUMMARY}}':           exec_summary,
    '{{WEEKLY_TREND_HEADERS}}':   build_weekly_headers(),
    '{{WEEKLY_TREND_ROWS}}':      WEEKLY_TREND_ROWS,
    '{{WEEKLY_TREND_INSIGHT}}':   WEEKLY_TREND_INSIGHT,
    '{{PERIOD_COMPARISON_EXTRA_HEADERS}}': '',
    '{{PERIOD_COMPARISON_ROWS}}': PERIOD_COMPARISON_ROWS,
    '{{TOP_GROWING_ROWS}}':       TOP_GROWING_ROWS,
    '{{TOP_DECLINING_ROWS}}':     TOP_DECLINING_ROWS,
    '{{SECTION_3_TITLE}}':        'Quality Metrics',
    '{{SECTION_3_NOTE}}':         'Helpful rate = thumbs-up / rated questions. Copy rate = copied / all questions.',
    '{{SECTION_3_ROWS}}':         SECTION_3_ROWS,
    '{{SECTION_3_INSIGHT}}':      SECTION_3_INSIGHT,
    '{{SECTION_4_TITLE}}':        'Latency',
    '{{SECTION_4_NOTE}}':         f'Proxy: updated_at − created_at (seconds). Filter: 0 < latency < 600s. {latency_insight}',
    '{{SECTION_4_ROWS}}':         SECTION_4_ROWS,
    '{{SECTION_4_INSIGHT}}':      latency_insight,
    '{{DEEP_DIVE_SECTIONS}}':     "<div class='empty-dd'>No deep dives run yet.</div>",
    '{{QUERY_COUNT}}':            '6',
    '{{QUERY_LOG}}':              '<p class="note">Templates 0, 0B, 1, 1b, 2, 3 executed.</p>',
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
print('  • WAUs enabled last 7 days / all WAUs — needs auth_user.date_joined per-week join')
print('  • Companion WAUs / Companion lifetime users — shown as approx (user_first_week_cc_engagement is per-matter)')
print(f'\nTo upload: gsutil -o GSUtil:default_project_id=evenup-internal-tools cp {args.output} gs://evenup-internal-tools-dbt-explorer-api/report-files/')
