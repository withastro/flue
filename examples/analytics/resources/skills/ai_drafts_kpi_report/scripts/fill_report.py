#!/usr/bin/env python3
"""
fill_report.py — AI Drafts KPI report template filler.

Usage:
    python3 .claude/skills/ai_drafts_kpi_report/scripts/fill_report.py \
        --template-0 /tmp/ai_drafts_t0.csv \
        --template-1 /tmp/ai_drafts_t1.csv \
        --template-2 /tmp/ai_drafts_t2.csv \
        --output /tmp/ai_drafts_report_YYYYMMDD.html
"""
import argparse, csv, os
from collections import defaultdict
from datetime import date, timedelta

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE  = os.path.join(SKILL_DIR, 'references', 'report_template.html')

p = argparse.ArgumentParser()
p.add_argument('--template-0', required=True, dest='t0')
p.add_argument('--template-1', required=True, dest='t1')
p.add_argument('--template-2', required=True, dest='t2')
p.add_argument('--output',     required=True)
args = p.parse_args()

def load(path):
    if not path or not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))

t0_raw = load(args.t0)
t1_raw = load(args.t1)
t2_raw = load(args.t2)

# ── DATE WINDOWS ──────────────────────────────────────────────────────────────
today    = date.today()
cur_week = today - timedelta(days=today.weekday())
ALL_8_D  = [cur_week - timedelta(weeks=w) for w in range(8, 0, -1)]
ALL_8    = [d.strftime('%Y-%m-%d') for d in ALL_8_D]
RECENT   = set(ALL_8[-2:])
PRIOR    = set(ALL_8[-6:-2])
WK_LABELS = [d.strftime('%b %-d') for d in ALL_8_D]

# ── HELPERS ───────────────────────────────────────────────────────────────────
def pct_chg(a, b): return (a - b) / b * 100 if b else None
def arrow(p):
    if p is None or abs(p) <= 1: return '→', 'flat', '→'
    if p > 0: return '▲', 'up', f'+{p:.1f}%'
    return '▼', 'down', f'{p:.1f}%'
def fi(v): return f'{int(round(v)):,}'
def ff(v, d=1): return f'{v:.{d}f}'
def pct_fmt(v): return f'{v*100:.1f}%' if v is not None else '—'

def badge(dt):
    if dt == 'Express Demand':
        return '<span class="badge-seg1">XD</span>'
    return '<span class="badge-seg2">MM</span>'

# ── INDEX RAW DATA ─────────────────────────────────────────────────────────────
t0 = {}
for r in t0_raw:
    t0[(r['week_start'], r['draft_type'])] = {
        'requests': int(r['total_requests']),
        'firms':    int(r['active_firms']),
        'users':    int(r['active_users']),
        'matters':  int(r['distinct_matters']),
    }

t1 = {}
for r in t1_raw:
    t1[(r['week_start'], r['draft_type'])] = {
        'total':      int(r['total_requests']),
        'downloaded': int(r['downloaded_requests']),
        'pct':        float(r['pct_downloaded']),
    }

t2 = {}
for r in t2_raw:
    t2[(r['week_start'], r['draft_type'])] = {
        'p50': float(r['p50_minutes']),
        'p95': float(r['p95_minutes']),
    }

# ── PERIOD AGGREGATION ────────────────────────────────────────────────────────
def t0_period(dt):
    rr = rf = ru = pr = pf = pu = 0
    for w in RECENT:
        d = t0.get((w, dt), {})
        rr += d.get('requests', 0); rf += d.get('firms', 0); ru += d.get('users', 0)
    for w in PRIOR:
        d = t0.get((w, dt), {})
        pr += d.get('requests', 0); pf += d.get('firms', 0); pu += d.get('users', 0)
    rpw = rr / 2; ppw = pr / 4
    return {'rpw': rpw, 'ppw': ppw, 'pct': pct_chg(rpw, ppw),
            'firms_r': rf / 2, 'users_r': ru / 2}

def t1_period(dt):
    rt = rd = pt = pd = 0
    for w in RECENT:
        d = t1.get((w, dt), {})
        rt += d.get('total', 0); rd += d.get('downloaded', 0)
    for w in PRIOR:
        d = t1.get((w, dt), {})
        pt += d.get('total', 0); pd += d.get('downloaded', 0)
    r_pct = rd / rt if rt else None
    p_pct = pd / pt if pt else None
    return {'r_pct': r_pct, 'p_pct': p_pct,
            'pct': pct_chg(r_pct or 0, p_pct or 1) if p_pct else None}

def t2_period(dt):
    rp50 = rp95 = rc = pp50 = pp95 = pc = 0
    for w in RECENT:
        d = t2.get((w, dt), {})
        if d: rp50 += d['p50']; rp95 += d['p95']; rc += 1
    for w in PRIOR:
        d = t2.get((w, dt), {})
        if d: pp50 += d['p50']; pp95 += d['p95']; pc += 1
    r50 = rp50 / rc if rc else 0; p50 = pp50 / pc if pc else 0
    r95 = rp95 / rc if rc else 0; p95 = pp95 / pc if pc else 0
    return {'r50': r50, 'p50': p50, 'pct50': pct_chg(r50, p50),
            'r95': r95, 'p95': p95}

xd_t0 = t0_period('Express Demand'); mm_t0 = t0_period('Mirror Mode')
xd_t1 = t1_period('Express Demand'); mm_t1 = t1_period('Mirror Mode')
xd_t2 = t2_period('Express Demand'); mm_t2 = t2_period('Mirror Mode')

tot_rpw = xd_t0['rpw'] + mm_t0['rpw']
tot_ppw = xd_t0['ppw'] + mm_t0['ppw']
tot_pct = pct_chg(tot_rpw, tot_ppw)

# Combined download rate
rt_all = sum(t1.get((w, dt), {}).get('total', 0)      for w in RECENT for dt in ['Express Demand','Mirror Mode'])
rd_all = sum(t1.get((w, dt), {}).get('downloaded', 0) for w in RECENT for dt in ['Express Demand','Mirror Mode'])
pt_all = sum(t1.get((w, dt), {}).get('total', 0)      for w in PRIOR  for dt in ['Express Demand','Mirror Mode'])
pd_all = sum(t1.get((w, dt), {}).get('downloaded', 0) for w in PRIOR  for dt in ['Express Demand','Mirror Mode'])
tot_r_pct = rd_all / rt_all if rt_all else None
tot_p_pct = pd_all / pt_all if pt_all else None

# ── ANOMALY DETECTION ─────────────────────────────────────────────────────────
THRESHOLD = 10.0
flagged = []
def chk(name, pct):
    if pct is not None and abs(pct) > THRESHOLD:
        flagged.append((name, pct))

chk('Total Requests', tot_pct)
chk('XD Requests',   xd_t0['pct'])
chk('MM Requests',   mm_t0['pct'])
chk('% Downloaded (XD)', xd_t1['pct'])
chk('% Downloaded (MM)', mm_t1['pct'])
chk('Median TAT (XD)',   xd_t2['pct50'])
chk('Median TAT (MM)',   mm_t2['pct50'])

# ── SECTION 1: WEEKLY TREND ────────────────────────────────────────────────────
report_date   = date.today().strftime('%Y-%m-%d')
recent_label  = f"{ALL_8_D[-2].strftime('%b %-d')} – {ALL_8_D[-1].strftime('%b %-d')}"
prior_label   = f"{ALL_8_D[-6].strftime('%b %-d')} – {ALL_8_D[-3].strftime('%b %-d')}"

wk_headers = ''.join(
    f'<th class="num{" wk-recent" if ALL_8[i] in RECENT else ""}">{WK_LABELS[i]}</th>'
    for i in range(8)
)

def metric_row(label, data_dict, dt, key, fmt=fi):
    cells = ''.join(
        f'<td class="num{" wk-recent" if w in RECENT else ""}">'
        f'{fmt(data_dict.get((w, dt), {}).get(key, 0))}</td>'
        for w in ALL_8
    )
    return f'<tr><td>{label}</td>{cells}</tr>'

def pct_row(label, dt):
    cells = ''.join(
        f'<td class="num{" wk-recent" if w in RECENT else ""}">'
        f'{pct_fmt(t1.get((w, dt), {}).get("pct", None))}</td>'
        for w in ALL_8
    )
    return f'<tr><td>{label}</td>{cells}</tr>'

def tat_row(label, dt, key):
    cells = ''.join(
        f'<td class="num{" wk-recent" if w in RECENT else ""}">'
        f'{ff(t2.get((w, dt), {}).get(key, 0))} min</td>'
        for w in ALL_8
    )
    return f'<tr><td>{label}</td>{cells}</tr>'

weekly_rows = '\n'.join([
    metric_row('XD Requests',         t0, 'Express Demand', 'requests'),
    metric_row('MM Requests',         t0, 'Mirror Mode',    'requests'),
    metric_row('XD Active Firms',     t0, 'Express Demand', 'firms'),
    metric_row('MM Active Firms',     t0, 'Mirror Mode',    'firms'),
    pct_row('XD % Downloaded',        'Express Demand'),
    pct_row('MM % Downloaded',        'Mirror Mode'),
    tat_row('XD Median TAT (min)',     'Express Demand', 'p50'),
    tat_row('MM Median TAT (min)',     'Mirror Mode',    'p50'),
])

# ── EXEC SUMMARY ─────────────────────────────────────────────────────────────
def exec_summary():
    parts = []
    if tot_pct is not None:
        d = 'up' if tot_pct > 0 else 'down'
        parts.append(f"Total AI Draft requests are {d} {abs(tot_pct):.1f}% vs prior period "
                     f"({fi(tot_rpw)}/wk recent vs {fi(tot_ppw)}/wk prior).")
    if tot_r_pct is not None and tot_p_pct is not None:
        dl_chg = pct_chg(tot_r_pct, tot_p_pct)
        if dl_chg is not None:
            d = 'up' if dl_chg > 0 else 'down'
            parts.append(f"Overall download rate is {d} {abs(dl_chg):.1f}% "
                         f"({pct_fmt(tot_r_pct)} recent vs {pct_fmt(tot_p_pct)} prior).")
    if flagged:
        parts.append(f"⚠️ Flagged for investigation: {', '.join(n for n,_ in flagged)}.")
    return ' '.join(parts) or 'No significant changes this period.'

insight = (f"XD: {fi(xd_t0['rpw'])}/wk recent "
           f"({'%+.1f' % xd_t0['pct'] if xd_t0['pct'] else '—'}% vs prior). "
           f"MM: {fi(mm_t0['rpw'])}/wk recent "
           f"({'%+.1f' % mm_t0['pct'] if mm_t0['pct'] else '—'}% vs prior).")

# ── SECTION 2: PERIOD COMPARISON ──────────────────────────────────────────────
def cmp_row(label, dt, rpw, ppw, pct):
    a_sym, a_cls, a_txt = arrow(pct)
    return (f'<tr><td>{badge(dt)} {label}</td>'
            f'<td class="num">{fi(ppw)}</td>'
            f'<td class="num">{fi(rpw)}</td>'
            f'<td class="num {a_cls}">{a_sym} {a_txt}</td></tr>')

period_rows = '\n'.join([
    cmp_row('XD Requests', 'Express Demand', xd_t0['rpw'], xd_t0['ppw'], xd_t0['pct']),
    cmp_row('MM Requests', 'Mirror Mode',    mm_t0['rpw'], mm_t0['ppw'], mm_t0['pct']),
    f'<tr><td><strong>Total Requests</strong></td>'
    f'<td class="num">{fi(tot_ppw)}</td><td class="num">{fi(tot_rpw)}</td>'
    f'<td class="num {arrow(tot_pct)[1]}">{arrow(tot_pct)[0]} {arrow(tot_pct)[2]}</td></tr>',
])

def dl_row(label, dt, r_pct, p_pct):
    pct = pct_chg(r_pct or 0, p_pct or 1) if p_pct else None
    a_sym, a_cls, a_txt = arrow(pct)
    return (f'<tr><td>{badge(dt)} {label} <span class="p0">P0</span></td>'
            f'<td class="num">{pct_fmt(p_pct)}</td>'
            f'<td class="num">{pct_fmt(r_pct)}</td>'
            f'<td class="num {a_cls}">{a_sym} {a_txt}</td></tr>')

dl_rows = '\n'.join([
    dl_row('XD % Downloaded', 'Express Demand', xd_t1['r_pct'], xd_t1['p_pct']),
    dl_row('MM % Downloaded', 'Mirror Mode',    mm_t1['r_pct'], mm_t1['p_pct']),
    (f'<tr><td><strong>Overall % Downloaded</strong> <span class="p0">P0</span></td>'
     f'<td class="num">{pct_fmt(tot_p_pct)}</td><td class="num">{pct_fmt(tot_r_pct)}</td>'
     f'<td class="num {arrow(pct_chg(tot_r_pct or 0, tot_p_pct or 1))[1]}">'
     f'{arrow(pct_chg(tot_r_pct or 0, tot_p_pct or 1))[0]} '
     f'{arrow(pct_chg(tot_r_pct or 0, tot_p_pct or 1))[2]}</td></tr>'),
])

# ── SECTION 3: TURNAROUND TIME ────────────────────────────────────────────────
tat_rows = []
for dt, lbl, t2d in [('Express Demand', 'XD', xd_t2), ('Mirror Mode', 'MM', mm_t2)]:
    a_sym, a_cls, a_txt = arrow(t2d['pct50'])
    tat_rows.append(
        f'<tr><td>{badge(dt)} {lbl} Median TAT</td><td class="p1">P1</td>'
        f'<td class="num">{ff(t2d["p50"])} min</td>'
        f'<td class="num">{ff(t2d["r50"])} min</td>'
        f'<td class="num {a_cls}">{a_sym} {a_txt}</td></tr>'
    )
    tat_rows.append(
        f'<tr><td>{badge(dt)} {lbl} p95 TAT</td><td class="p2">P2</td>'
        f'<td class="num">{ff(t2d["p95"])} min</td>'
        f'<td class="num">{ff(t2d["r95"])} min</td>'
        f'<td class="num">—</td></tr>'
    )

tat_insight = (f"XD median TAT: {ff(xd_t2['r50'])} min recent vs {ff(xd_t2['p50'])} min prior. "
               f"MM median TAT: {ff(mm_t2['r50'])} min recent vs {ff(mm_t2['p50'])} min prior.")

# ── FILL TEMPLATE ─────────────────────────────────────────────────────────────
with open(TEMPLATE) as f:
    html = f.read()

html = html.replace('{{PRODUCT_NAME}}',              'AI Drafts (XD + MM)')
html = html.replace('{{REPORT_DATE}}',               report_date)
html = html.replace('{{RECENT_RANGE}}',              recent_label)
html = html.replace('{{PRIOR_RANGE}}',               prior_label)
html = html.replace('{{EXEC_SUMMARY}}',              exec_summary())
html = html.replace('{{WEEKLY_TREND_HEADERS}}',      wk_headers)
html = html.replace('{{WEEKLY_TREND_ROWS}}',         weekly_rows)
html = html.replace('{{WEEKLY_TREND_INSIGHT}}',      insight)
html = html.replace('{{PERIOD_COMPARISON_EXTRA_HEADERS}}', '')
html = html.replace('{{PERIOD_COMPARISON_ROWS}}',    period_rows)
html = html.replace('{{TOP_GROWING_LABEL}}',         'P0: % AI Drafts Downloaded by Type')
html = html.replace('{{TOP_GROWING_ROWS}}',          dl_rows)
html = html.replace('{{TOP_DECLINING_ROWS}}',        '')
html = html.replace('{{SECTION_3_TITLE}}',           'Turnaround Time (TAT)')
html = html.replace('{{SECTION_3_NOTE}}',            'Minutes from request submission to first AI-generated revision. P50 = median, P95 = 95th percentile. Per-week averages of weekly medians.')
html = html.replace('{{SECTION_3_ROWS}}',            '\n'.join(tat_rows))
html = html.replace('{{SECTION_3_INSIGHT}}',         tat_insight)
html = html.replace('{{DEEP_DIVE_SECTIONS}}',        "<div class='empty-dd'>No deep dives run yet.</div>")
html = html.replace('{{QUERY_COUNT}}',               '3')
html = html.replace('{{QUERY_LOG}}',
    '<div class="query-block">T0: WEEKLY_REQUEST_VOLUME (~840 MB)\n'
    'T1: DOWNLOAD_FUNNEL (~1.2 GB, --max-gb 2)\n'
    'T2: TURNAROUND_TIME (~1.0 GB, --max-gb 2)</div>')

with open(args.output, 'w') as f:
    f.write(html)

print(f'Report saved to {args.output}')
if flagged:
    print('FLAGGED METRICS: ' + ', '.join(f'{n} ({v:+.1f}%)' for n, v in flagged))
else:
    print('No metrics flagged (all within ±10% threshold).')
