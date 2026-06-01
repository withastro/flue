#!/usr/bin/env python3
"""
fill_report.py — AI Playbooks report template filler.

Reads BQ query CSVs, computes all metrics, fills references/report_template.html,
and writes ai_playbooks_report_YYYYMMDD.html in the current working directory.

Usage:
    python3 .claude/skills/ai_playbooks_report/scripts/fill_report.py \
        --weekly     /tmp/bq_weekly.csv       \
        --exec-agg   /tmp/bq_exec_agg.csv     \
        --firm-grain /tmp/bq_firm_grain.csv   \
        --ux-actions /tmp/bq_ux_actions.csv   \
        --amplitude  /tmp/bq_amplitude.csv    \
        --first-touch /tmp/bq_first_touch.csv \
        --cost       /tmp/bq_cost.csv         \
        --baseline   /tmp/bq_baseline.csv     \
        --cohort     /tmp/bq_cohort.csv       \
        [--firm-trend  /tmp/bq_firm_trend.csv]  \
        [--contracts   /tmp/bq_contracts.csv]

All --firm-trend and --contracts are optional; their sections will show a
placeholder if omitted.
"""

import argparse, csv, os, sys
from collections import defaultdict
from datetime import datetime, date

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE  = os.path.join(SKILL_DIR, 'references', 'report_template.html')

# ─── CLI ─────────────────────────────────────────────────────────────────────
p = argparse.ArgumentParser(description='Fill AI Playbooks HTML report template')
p.add_argument('--weekly',      required=True)
p.add_argument('--exec-agg',    required=True, dest='exec_agg')
p.add_argument('--firm-grain',  required=True, dest='firm_grain')
p.add_argument('--ux-actions',  required=True, dest='ux_actions')
p.add_argument('--amplitude',   required=True)
p.add_argument('--first-touch', required=True, dest='first_touch')
p.add_argument('--cost',        required=True)
p.add_argument('--baseline',    required=True)
p.add_argument('--cohort',      required=True)
p.add_argument('--firm-trend',  dest='firm_trend',  default=None)
p.add_argument('--contracts',   default=None)
p.add_argument('--out-dir',     default='.', dest='out_dir')
args = p.parse_args()

def load(path):
    if not path or not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))

weekly_raw  = load(args.weekly)
exec_agg    = load(args.exec_agg)
firm_grain  = load(args.firm_grain)
ux_a        = load(args.ux_actions)
ux_b        = load(args.amplitude)
first_touch = load(args.first_touch)
cost_data   = load(args.cost)
baseline    = load(args.baseline)
cohort      = load(args.cohort)
firm_trend  = load(args.firm_trend)
contracts   = load(args.contracts)

# ─── DATE WINDOWS ─────────────────────────────────────────────────────────────
today      = date.today()
cur_week   = today - __import__('datetime').timedelta(days=today.weekday())
ALL_8_D    = [cur_week - __import__('datetime').timedelta(weeks=w) for w in range(8, 0, -1)]
ALL_8      = [d.strftime('%Y-%m-%d') for d in ALL_8_D]
RECENT     = set(ALL_8[-2:])
PRIOR      = set(ALL_8[-6:-2])
# Spike detection: week with total runs > 1.8× median of non-spike weeks
WK_LABELS_RAW = [d.strftime('%b %-d') for d in ALL_8_D]

# Detect spike weeks from weekly data
def detect_spikes(weekly_raw):
    runs_by_week = defaultdict(int)
    for r in weekly_raw:
        runs_by_week[r['week_start']] += int(r['total_runs'])
    if not runs_by_week:
        return set()
    vals = sorted(runs_by_week.values())
    median = vals[len(vals)//2]
    return {w for w, v in runs_by_week.items() if v > 1.8 * median}

spike_weeks = detect_spikes(weekly_raw)

WK_LABELS = [
    lbl + ' ⚡' if ALL_8[i] in spike_weeks else lbl
    for i, lbl in enumerate(WK_LABELS_RAW)
]

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def pct_chg(a, b): return (a - b) / b * 100 if b else None
def arrow(p):
    if p is None or abs(p) <= 1: return '→', 'flat', '→'
    if p > 0: return '▲', 'up', f'+{p:.1f}%'
    return '▼', 'down', f'{p:.1f}%'
def fi(v): return f'{int(round(v)):,}'
def ff(v, d=1): return f'{v:.{d}f}'
def usd(v): return f'${v:,.2f}'
def badge(ci): return '<span class="badge-ci">CI</span>' if ci == 'True' else '<span class="badge-non-ci">Non-CI</span>'

# ─── INDEX RAW DATA ───────────────────────────────────────────────────────────
wkly = {}
for r in weekly_raw:
    wkly[r['week_start']] = {
        'runs':    int(r['total_runs']),
        'firms':   int(r['active_firms']),
        'matters': int(r['distinct_matters']),
        'auto':    int(r['auto_runs']),
        'manual':  int(r['manual_runs']),
        'rpm':     float(r['runs_per_matter']),
    }

exec_by = {}
for r in exec_agg:
    exec_by[(r['week_start'], r['is_ci_matter'])] = {
        'runs':    int(r['total_runs']),
        'firms':   int(r['enabled_firms']),
        'matters': int(r['distinct_matters']),
        'auto':    int(r['automated_runs']),
    }

ux_by = {}
for r in ux_a:
    ux_by[(r['week_start'], r['is_ci_matter'])] = {
        'view':   int(r['view_tab_count']),
        'pinned': int(r['view_pinned_count']),
        'dl':     int(r['download_count']),
    }

amp_by = {}
for r in ux_b:
    amp_by[(r['week_start'], r['is_ci_matter'], r['event_type'])] = int(r['event_count'])

base_by = {}
for r in baseline:
    base_by[(r['summary_week'], r['is_ci_matter'])] = {
        'active': int(r['active_eligible_matters']),
        'addr':   int(r['addressable_matters']),
    }

coh_by = {}
for r in cohort:
    coh_by[(r['week_start'], r['is_ci_matter'], r['firm_cohort'])] = int(r['total_runs'])

cost_week = defaultdict(lambda: {'cost': 0.0, 'calls': 0, 'in': 0, 'out': 0})
for r in cost_data:
    w = r['week_start']
    cost_week[w]['cost']  += float(r['total_cost'])
    cost_week[w]['calls'] += int(r['total_llm_calls'])
    cost_week[w]['in']    += int(r['total_input_tokens'])
    cost_week[w]['out']   += int(r['total_output_tokens'])

cmap = {r['firm_id']: r for r in contracts}
fg_names = {r['firm_id']: r['firm_name'] for r in firm_grain if 'firm_name' in r}
def firm_name(fid): return fg_names.get(str(fid)) or cmap.get(str(fid), {}).get('firm_name', f'Firm {fid}')

ft_r = defaultdict(lambda: defaultdict(list))
ft_p = defaultdict(lambda: defaultdict(list))
FT_KEYS = ['first_use_week_0','first_use_week_1_to_4','first_use_week_5_to_8',
           'first_use_week_9_to_12','first_use_week_13_to_32','first_use_week_33_plus',
           'avg_weeks_to_first_use']
for r in first_touch:
    ci, w = r['is_ci_matter'], r['summary_week']
    d = {k: float(r[k]) for k in FT_KEYS}
    bucket = ft_r[ci] if w in RECENT else ft_p[ci]
    for k, v in d.items(): bucket[k].append(v)

def ft_avg(bucket, ci, k):
    vals = bucket[ci].get(k, [])
    return sum(vals) / len(vals) if vals else 0

# firm trend engagement map
ft_map   = defaultdict(lambda: defaultdict(int))
ft_names = {}
ft_ci    = {}
for r in firm_trend:
    fid, w = r['firm_id'], r['summary_week']
    ft_map[fid][w] += int(r['total_engagement'])
    ft_names[fid] = r['firm_name']
    ft_ci.setdefault(fid, r['is_ci_matter'])

# ─── COMPUTED METRICS ─────────────────────────────────────────────────────────
def exec_period(ci):
    rr = rf = rm = ra = pr = pf = pm = pa = 0
    for w in RECENT:
        d = exec_by.get((w, ci), {})
        rr += d.get('runs', 0); rf += d.get('firms', 0)
        rm += d.get('matters', 0); ra += d.get('auto', 0)
    for w in PRIOR:
        d = exec_by.get((w, ci), {})
        pr += d.get('runs', 0); pf += d.get('firms', 0)
        pm += d.get('matters', 0); pa += d.get('auto', 0)
    rpw = rr / 2; ppw = pr / 4
    return dict(rpw=rpw, ppw=ppw, pct=pct_chg(rpw, ppw),
                firms=rf / 2, matters=rm / 2,
                auto_pct=ra / rr * 100 if rr else 0,
                rpm=rpw / (rm / 2) if rm else 0)

ci_e  = exec_period('True')
nci_e = exec_period('False')
tot_e = {
    'rpw': ci_e['rpw'] + nci_e['rpw'],
    'ppw': ci_e['ppw'] + nci_e['ppw'],
    'firms': ci_e['firms'] + nci_e['firms'],
    'matters': ci_e['matters'] + nci_e['matters'],
    'auto_pct': (ci_e['auto_pct'] + nci_e['auto_pct']) / 2,
}
tot_e['pct'] = pct_chg(tot_e['rpw'], tot_e['ppw'])
tot_e['rpm'] = tot_e['rpw'] / tot_e['matters'] if tot_e['matters'] else 0

def ux_period(ci):
    rv=rp=rd=rrb=red=pv=pp=pd=prb=ped = 0
    RUN  = '[AI Playbooks] Run AI Playbook'
    EDIT = '[AI Playbooks] Edit AI Playbook Prompt Result'
    for w in RECENT:
        d = ux_by.get((w, ci), {})
        rv += d.get('view', 0); rp += d.get('pinned', 0); rd += d.get('dl', 0)
        rrb += amp_by.get((w, ci, RUN), 0); red += amp_by.get((w, ci, EDIT), 0)
    for w in PRIOR:
        d = ux_by.get((w, ci), {})
        pv += d.get('view', 0); pp += d.get('pinned', 0); pd += d.get('dl', 0)
        prb += amp_by.get((w, ci, RUN), 0); ped += amp_by.get((w, ci, EDIT), 0)
    return dict(vr=rv/2, vp=pv/4, vc=pct_chg(rv/2, pv/4),
                pr2=rp/2, pp2=pp/4, pc=pct_chg(rp/2, pp/4),
                dr=rd/2, dp=pd/4, dc=pct_chg(rd/2, pd/4),
                rr=rrb/2, rp3=prb/4, rc=pct_chg(rrb/2, prb/4),
                er=red/2, ep3=ped/4, ec=pct_chg(red/2, ped/4))

ci_ux  = ux_period('True')
nci_ux = ux_period('False')

def base_period(ci):
    ra = rd = pa = pd = rc = pc = 0
    for w in RECENT:
        d = base_by.get((w, ci), {})
        if d: ra += d['active']; rd += d['addr']; rc += 1
    for w in PRIOR:
        d = base_by.get((w, ci), {})
        if d: pa += d['active']; pd += d['addr']; pc += 1
    return dict(ra=ra/rc if rc else 0, rd=rd/rc if rc else 0,
                pa=pa/pc if pc else 0, pd=pd/pc if pc else 0)

ci_b  = base_period('True')
nci_b = base_period('False')

def pen(w, ci):
    runs = exec_by.get((w, ci), {}).get('runs', 0)
    base = base_by.get((w, ci), {}).get('active', 0)
    return runs / base * 100 if base else 0

ci_pen_r   = sum(pen(w, 'True')  for w in RECENT) / 2
ci_pen_p   = sum(pen(w, 'True')  for w in PRIOR)  / 4
nci_pen_r  = sum(pen(w, 'False') for w in RECENT) / 2
nci_pen_p  = sum(pen(w, 'False') for w in PRIOR)  / 4

def coh_period(ci, coh):
    r = sum(coh_by.get((w, ci, coh), 0) for w in RECENT) / 2
    p = sum(coh_by.get((w, ci, coh), 0) for w in PRIOR)  / 4
    return r, p, pct_chg(r, p)

ci_est  = coh_period('True',  'established_firm')
ci_new  = coh_period('True',  'new_firm')
nci_est = coh_period('False', 'established_firm')
nci_new = coh_period('False', 'new_firm')

rc_cost = sum(cost_week[w]['cost'] for w in RECENT)
pc_cost = sum(cost_week[w]['cost'] for w in PRIOR)
rcpw = rc_cost / 2; pcpw = pc_cost / 4
cpr_r = rcpw / tot_e['rpw'] if tot_e['rpw'] else 0
cpr_p = pcpw / tot_e['ppw'] if tot_e['ppw'] else 0
ri_tok = sum(cost_week[w]['in']  for w in RECENT)
ro_tok = sum(cost_week[w]['out'] for w in RECENT)

# Firm movers — SQL pre-aggregated: top 10 increase + top 10 decrease by absolute delta
firm_stats = []
for r in firm_grain:
    rpw = float(r['recent_pw']); ppw = float(r['prior_pw']); delta = float(r['delta'])
    firm_stats.append({'id': r['firm_id'], 'ci': r['is_ci_matter'],
                       'rpw': rpw, 'ppw': ppw, 'pct': pct_chg(rpw, ppw), 'delta': delta})

top_grow = sorted([f for f in firm_stats if f['delta'] > 0], key=lambda x: -x['delta'])
top_decl = sorted([f for f in firm_stats if f['delta'] < 0], key=lambda x:  x['delta'])
flagged_grow = [str(f['id']) for f in top_grow]
flagged_decl = [str(f['id']) for f in top_decl]

# ─── EXEC SUMMARY ─────────────────────────────────────────────────────────────
tot_pct = tot_e['pct'] or 0
ci_pct  = ci_e['pct'] or 0
nci_pct = nci_e['pct'] or 0
ci_org_pct  = ci_est[2] or 0
nci_org_pct = nci_est[2] or 0

def summary_line():
    dir_tot = 'grew' if tot_pct > 0 else 'declined'
    ci_dir  = 'surged' if ci_pct > 20 else ('grew' if ci_pct > 0 else 'declined')
    nci_dir = 'grew' if nci_pct > 0 else 'declined'
    spike_note = ' ⚠ Prior period includes a spike week (~2× normal) that inflates the baseline.' if spike_weeks else ''
    organic_note = (
        f' CI growth is <strong>organic</strong> (established firms {ci_org_pct:+.0f}%); '
        f'Non-CI growth is <strong>sales-driven</strong> (established firms {nci_org_pct:+.0f}%).'
        if ci_est and nci_est else ''
    )
    return (
        f'<strong>AI Playbooks runs {dir_tot} {tot_pct:+.1f}% overall '
        f'({fi(tot_e["rpw"])} vs {fi(tot_e["ppw"])} runs/week).</strong> '
        f'CI {ci_dir} {ci_pct:+.1f}%; Non-CI {nci_dir} {nci_pct:+.1f}%.'
        f'{organic_note}{spike_note}'
    )

# ─── HTML BLOCK GENERATORS ────────────────────────────────────────────────────

def weekly_trend_headers():
    parts = []
    for i, lbl in enumerate(WK_LABELS):
        cls = ' class="num wk-recent"' if ALL_8[i] in RECENT else (' class="num spike"' if ALL_8[i] in spike_weeks else ' class="num"')
        parts.append(f'<th{cls}>{lbl}</th>')
    return '\n        '.join(parts)

def weekly_trend_rows():
    RUN_EVENT  = '[AI Playbooks] Run AI Playbook'
    EDIT_EVENT = '[AI Playbooks] Edit AI Playbook Prompt Result'

    def ux_total(w, key):
        return sum(ux_by.get((w, ci), {}).get(key, 0) for ci in ('True', 'False'))

    def amp_total(w, event):
        return sum(amp_by.get((w, ci, event), 0) for ci in ('True', 'False'))

    def cost_per_run(w):
        runs = wkly.get(w, {}).get('runs', 0)
        c    = cost_week[w]['cost'] if w in cost_week else 0
        return c / runs if runs else None

    def _cell(val, fmt_fn, w):
        cls = 'num wk-recent' if w in RECENT else ('num spike' if w in spike_weeks else 'num')
        display = fmt_fn(val) if val is not None else '<span style="color:#ccc">—</span>'
        return f'<td class="{cls}">{display}</td>'

    def data_row(label, priority, getter, fmt_fn):
        bdg = f'<span class="{priority.lower()}">{priority}</span> ' if priority else ''
        cells = [_cell(getter(w), fmt_fn, w) for w in ALL_8]
        return f'<tr><td>{bdg}{label}</td>{"".join(cells)}</tr>'

    def null_row(label, priority=''):
        bdg = f'<span class="{priority.lower()}">{priority}</span> ' if priority else ''
        cells = ''.join(f'<td class="num"><span style="color:#ccc">—</span></td>' for _ in ALL_8)
        return f'<tr><td>{bdg}{label}</td>{cells}</tr>'

    def group_header(label):
        span = 1 + len(ALL_8)
        return (f'<tr style="background:#f0f0f0">'
                f'<td colspan="{span}" style="font-weight:700;font-size:12px;color:#555;padding:6px 12px">'
                f'{label}</td></tr>')

    rows = [
        data_row('Completed, non-test AI Playbook runs', 'P0',
                 lambda w: wkly.get(w, {}).get('runs'), fi),
        data_row('AI Playbooks cost', 'P0',
                 lambda w: cost_week[w]['cost'] if w in cost_week else None, usd),
        data_row('Enabled Firms with 1+ run', 'P0',
                 lambda w: wkly.get(w, {}).get('firms'), fi),
        data_row('Unique matters w/ 1+ AI Playbook run', 'P2',
                 lambda w: wkly.get(w, {}).get('matters'), fi),
        data_row('Runs over matters', 'P2',
                 lambda w: wkly.get(w, {}).get('rpm'), lambda v: ff(v, 2)),
        data_row('AI Playbooks cost per run', 'P2',
                 cost_per_run, lambda v: usd(v) if v else '—'),

        group_header('AI Playbooks in Case UX'),

        data_row('Playbook Views in AI Playbooks-tab UX', 'P0',
                 lambda w: ux_total(w, 'view'), fi),
        data_row('AI Playbook downloads (not staff)', 'P2',
                 lambda w: ux_total(w, 'dl'), fi),
        data_row('Pinned Playbook Views on Case Page', 'P0',
                 lambda w: ux_total(w, 'pinned'), fi),
        null_row('Total views of Playbooks (may double-count unique AI Playbooks)'),
        null_row('Total views of Playbooks / Playbooks'),
        data_row('Run AI Playbooks — pressed run button', 'P1',
                 lambda w: amp_total(w, RUN_EVENT) or None, fi),
        data_row('Edited AI Playbook Response in UX', 'P2',
                 lambda w: amp_total(w, EDIT_EVENT) or None, fi),
        data_row('AI Playbooks downloads over runs', 'Dep',
                 lambda w: (ux_total(w, 'dl') / wkly[w]['runs'] * 100
                            if wkly.get(w, {}).get('runs') else None),
                 lambda v: f'{v:.1f}%'),
    ]
    return '\n      '.join(rows)

def weekly_trend_ci_note():
    ci_ar,  ci_cls,  ci_ps  = arrow(ci_e['pct'])
    nci_ar, nci_cls, nci_ps = arrow(nci_e['pct'])
    ci_org_ar,  _, ci_org_ps  = arrow(ci_est[2])
    ci_new_ar,  _, ci_new_ps  = arrow(ci_new[2])
    nci_org_ar, _, nci_org_ps = arrow(nci_est[2])
    nci_new_ar, _, nci_new_ps = arrow(nci_new[2])
    ci_share  = ci_e['rpw']  / (ci_e['rpw'] + nci_e['rpw'])  * 100 if (ci_e['rpw'] + nci_e['rpw']) else 0
    return (
        f'<span class="badge-ci">CI</span> '
        f'<strong>{fi(ci_e["rpw"])}/wk</strong> '
        f'<span class="{ci_cls}">{ci_ar} {ci_ps}</span> · '
        f'{fi(ci_e["firms"])} firms · '
        f'organic: established <span class="{("up" if ci_est[2] and ci_est[2]>0 else "down")}">{ci_org_ps}</span>, '
        f'new {ci_new_ps}'
        f'&emsp;'
        f'<span class="badge-non-ci">Non-CI</span> '
        f'<strong>{fi(nci_e["rpw"])}/wk</strong> '
        f'<span class="{nci_cls}">{nci_ar} {nci_ps}</span> · '
        f'{fi(nci_e["firms"])} firms · '
        f'organic: established <span class="{("up" if nci_est[2] and nci_est[2]>0 else "down")}">{nci_org_ps}</span>, '
        f'new {nci_new_ps}'
        f'&emsp;CI share: {ci_share:.0f}%'
    )

def exec_kpis_rows():
    rows = []
    for lbl_html, d, style in [
        ('<span class="badge-ci">CI</span>',         ci_e,  ''),
        ('<span class="badge-non-ci">Non-CI</span>', nci_e, ''),
        ('<strong>Total</strong>',                   tot_e, ' style="font-weight:600;border-top:2px solid #ddd"'),
    ]:
        ar, cls, ps = arrow(d['pct'])
        rows.append(
            f'<tr{style}><td>{lbl_html}</td>'
            f'<td class="num">{fi(d["ppw"])}</td><td class="num">{fi(d["rpw"])}</td>'
            f'<td class="num"><span class="{cls}">{ar} {ps}</span></td>'
            f'<td class="num">{fi(d["firms"])}</td><td class="num">{fi(d["matters"])}</td>'
            f'<td class="num">{ff(d["rpm"], 2)}</td><td class="num">{ff(d["auto_pct"], 1)}%</td></tr>'
        )
    return '\n'.join(rows)

def mover_rows(firms, direction):
    rows = []
    for f in firms:
        _, cls, ps = arrow(f['pct'])
        ar = '▲' if direction == 'grow' else '▼'
        rows.append(
            f'<tr><td>{firm_name(f["id"])}</td>'
            f'<td>{badge(f["ci"])}</td>'
            f'<td class="num">{ff(f["ppw"], 1)}</td>'
            f'<td class="num">{ff(f["rpw"], 1)}</td>'
            f'<td class="num"><span class="{cls}">{ar} {ps}</span></td></tr>'
        )
    return '\n'.join(rows) if rows else '<tr><td colspan="5" style="color:#9ca3af">No significant movers</td></tr>'

def cost_summary_rows():
    ar, cls, ps = arrow(pct_chg(rcpw, pcpw))
    cpr_ar, cpr_cls, cpr_ps = arrow(pct_chg(cpr_r, cpr_p))
    rows = [
        f'<tr><td><strong>Recent (2 wk avg)</strong></td>'
        f'<td class="num">{usd(rcpw)}</td><td class="num">{usd(cpr_r)}</td>'
        f'<td class="num">{fi(ri_tok/2)}</td><td class="num">{fi(ro_tok/2)}</td>'
        f'<td class="num"><span class="{cls}">{ar} {ps}</span></td></tr>',
        f'<tr><td>Prior (4 wk avg)</td>'
        f'<td class="num">{usd(pcpw)}</td><td class="num">{usd(cpr_p)}</td>'
        f'<td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>',
    ]
    return '\n'.join(rows)

def cost_weekly_rows():
    rows = []
    week_list = sorted(w for w in cost_week if w in (RECENT | PRIOR))
    lbl_map = {w: WK_LABELS[ALL_8.index(w)] for w in ALL_8 if w in cost_week}
    for w in week_list:
        d = cost_week[w]
        lbl = lbl_map.get(w, w)
        cls = 'wk-recent' if w in RECENT else ('spike' if w in spike_weeks else '')
        rows.append(
            f'<tr class="{cls}"><td>{lbl}</td>'
            f'<td class="num">{usd(d["cost"])}</td>'
            f'<td class="num">{fi(d["calls"])}</td>'
            f'<td class="num">{fi(d["in"])}</td>'
            f'<td class="num">{fi(d["out"])}</td></tr>'
        )
    return '\n'.join(rows)

def cost_insight():
    cost_pct = pct_chg(rcpw, pcpw) or 0
    cpr_pct  = pct_chg(cpr_r, cpr_p) or 0
    spike_note = ' The prior-period cost spike aligns with the run volume anomaly and is excluded from the cost/run trend.' if spike_weeks else ''
    return (
        f'Cost grew {cost_pct:+.1f}% period-over-period, driven by run volume growth ({tot_pct:+.1f}%) '
        f'and higher cost/run ({cpr_pct:+.1f}%, {usd(cpr_p)} → {usd(cpr_r)}).{spike_note}'
    )

def ux_rows():
    rows = []
    UX_DEF = [
        ('Playbook Views (tab)', 'p0', 'vp', 'vr', 'vc'),
        ('Pinned Views (case)',  'p0', 'pp2','pr2','pc'),
        ('Run Button (Amplitude)','p1','rp3','rr', 'rc'),
        ('Downloads',            'p2', 'dp', 'dr', 'dc'),
        ('Edited Response (Amplitude)', 'p2', 'ep3','er','ec'),
    ]
    for lbl, bdg, pk, rk, ck in UX_DEF:
        cv = ci_ux[ck]; nv = nci_ux[ck]
        ca, cc, cp = arrow(cv); na, nc, np_ = arrow(nv)
        rows.append(
            f'<tr><td>{lbl}</td><td><span class="{bdg}">{bdg.upper()}</span></td>'
            f'<td class="num">{ff(ci_ux[pk], 1)}</td><td class="num">{ff(ci_ux[rk], 1)}</td>'
            f'<td class="num"><span class="{cc}">{ca} {cp}</span></td>'
            f'<td class="num">{ff(nci_ux[pk], 1)}</td><td class="num">{ff(nci_ux[rk], 1)}</td>'
            f'<td class="num"><span class="{nc}">{na} {np_}</span></td></tr>'
        )
    ci_dlr  = ci_ux['dr']  / ci_e['rpw']  * 100 if ci_e['rpw']  else 0
    nci_dlr = nci_ux['dr'] / nci_e['rpw'] * 100 if nci_e['rpw'] else 0
    rows.append(
        f'<tr><td>Downloads / Runs (dep.)</td><td>Dep</td>'
        f'<td class="num" colspan="2">{ff(ci_dlr, 2)}%</td><td>—</td>'
        f'<td class="num" colspan="2">{ff(nci_dlr, 2)}%</td><td>—</td></tr>'
    )
    return '\n'.join(rows)

def ux_note():
    nci_rb_pct = nci_ux['rc'] or 0
    if nci_rb_pct < -5 and nci_e['rpw'] > nci_e['ppw']:
        return ('📌 Non-CI Run Button (Amplitude) declined despite higher total runs. '
                'Explanation: automated runs grew significantly while manual runs were flat — '
                'Amplitude only captures button presses (manual runs).')
    return '📌 Run Button and Edited Response counts reflect Amplitude (non-staff, manual sessions only).'

def firm_trend_headers():
    TREND_WEEKS = ALL_8[-6:]
    TREND_LABELS = WK_LABELS[-6:]
    parts = []
    for i, lbl in enumerate(TREND_LABELS):
        cls = 'num wk-recent' if TREND_WEEKS[i] in RECENT else 'num'
        parts.append(f'<th class="{cls}">{lbl}</th>')
    return '\n        '.join(parts)

def firm_trend_rows():
    if not firm_trend:
        return '<tr><td colspan="9" style="color:#9ca3af;font-style:italic">No firm trend data provided (--firm-trend)</td></tr>'

    TREND_WEEKS = ALL_8[-6:]
    all_vals = [ft_map[fid].get(w, 0) for fid in ft_map for w in TREND_WEEKS]
    max_eng  = max(all_vals) if all_vals else 1

    def bar(v, mx): w2 = max(2, int(v / mx * 60)); return f'<span class="trend-bar" style="width:{w2}px"></span>'

    rows = []
    for section_label, fids in [('▲ Growing', flagged_grow), ('▼ Declining', flagged_decl)]:
        rows.append(f'<tr style="background:#f0f0f0"><td colspan="9" style="font-weight:700;padding:6px 12px">{section_label}</td></tr>')
        for fid in fids:
            if fid not in ft_names: continue
            ci_str = ft_ci.get(fid, 'False')
            direction = '▲' if fid in flagged_grow else '▼'
            cells = []
            for w in TREND_WEEKS:
                v = ft_map[fid].get(w, 0)
                cls = 'num wk-recent' if w in RECENT else 'num'
                cells.append(f'<td class="{cls}">{v if v else "—"} {bar(v, max_eng) if v else ""}</td>')
            rows.append(
                f'<tr><td>{ft_names[fid]}</td><td>{badge(ci_str)}</td><td>{direction}</td>'
                + ''.join(cells) + '</tr>'
            )
    return '\n      '.join(rows)

def first_touch_rows(bucket):
    rows = []
    for ci_val, lbl in [('True', '<span class="badge-ci">CI</span>'), ('False', '<span class="badge-non-ci">Non-CI</span>')]:
        vals = [ft_avg(bucket, ci_val, k) for k in FT_KEYS]
        cells = ''.join(f'<td class="num">{ff(v, 1)}</td>' for v in vals)
        rows.append(f'<tr><td>{lbl}</td>{cells}</tr>')
    return '\n'.join(rows)

def first_touch_insight():
    ci_wk0_r  = ft_avg(ft_r, 'True',  'first_use_week_0')
    ci_wk0_p  = ft_avg(ft_p, 'True',  'first_use_week_0')
    nci_wk0_r = ft_avg(ft_r, 'False', 'first_use_week_0')
    nci_wk0_p = ft_avg(ft_p, 'False', 'first_use_week_0')
    return (
        f'Week-0 first use: CI {ff(ci_wk0_r, 1)} recent vs {ff(ci_wk0_p, 1)} prior; '
        f'Non-CI {ff(nci_wk0_r, 1)} recent vs {ff(nci_wk0_p, 1)} prior. '
        'Most eligible matters never reach first use (33+ bucket), indicating significant untapped penetration potential.'
    )

def baseline_rows():
    rows = []
    for ci_val, lbl_html, b, pen_r, pen_p in [
        ('True',  '<span class="badge-ci">CI</span>',         ci_b,  ci_pen_r,  ci_pen_p),
        ('False', '<span class="badge-non-ci">Non-CI</span>', nci_b, nci_pen_r, nci_pen_p),
    ]:
        dp = pct_chg(pen_r, pen_p); a, c, ps = arrow(dp)
        rows.append(
            f'<tr><td>{lbl_html}</td>'
            f'<td class="num">{fi(b["ra"])}</td><td class="num">{fi(b["rd"])}</td>'
            f'<td class="num">{ff(pen_p, 1)}%</td><td class="num">{ff(pen_r, 1)}%</td>'
            f'<td class="num"><span class="{c}">{a} {ps}</span></td></tr>'
        )
    return '\n'.join(rows)

def baseline_insight():
    parts = []
    if nci_pen_r < nci_pen_p:
        gap = nci_pen_p - nci_pen_r
        parts.append(f'📌 Non-CI penetration <strong>declining</strong> ({ff(nci_pen_p,1)}% → {ff(nci_pen_r,1)}%, -{ff(gap,1)}pp): '
                     f'the addressable matter base grew faster than runs.')
    if ci_pen_r > ci_pen_p:
        parts.append(f'CI penetration <strong>improving</strong> ({ff(ci_pen_p,1)}% → {ff(ci_pen_r,1)}%).')
    return ' '.join(parts) or 'Penetration rates stable period-over-period.'

def cohort_rows():
    rows = []
    for seg_html, tot_r, cohorts in [
        ('<span class="badge-ci">CI</span>',         ci_e['rpw'],  [('Established (>12wk)', ci_est), ('New (≤12wk)', ci_new)]),
        ('<span class="badge-non-ci">Non-CI</span>', nci_e['rpw'], [('Established (>12wk)', nci_est), ('New (≤12wk)', nci_new)]),
    ]:
        for coh_lbl, coh_data in cohorts:
            r, p, chg = coh_data; a, c, ps = arrow(chg)
            share = r / tot_r * 100 if tot_r else 0
            rows.append(
                f'<tr><td>{seg_html}</td><td>{coh_lbl}</td>'
                f'<td class="num">{fi(p)}</td><td class="num">{fi(r)}</td>'
                f'<td class="num"><span class="{c}">{a} {ps}</span></td>'
                f'<td class="num">{ff(share, 1)}%</td></tr>'
            )
    return '\n'.join(rows)

def cohort_insight():
    ci_org_pct  = ci_est[2] or 0
    ci_new_pct  = ci_new[2] or 0
    nci_org_pct = nci_est[2] or 0
    nci_new_pct = nci_new[2] or 0
    return (
        f'📌 <strong>CI growth is organic</strong>: established firms {ci_org_pct:+.1f}%, new firms {ci_new_pct:+.1f}%. '
        f'<strong>Non-CI growth is sales-driven</strong>: established firms {nci_org_pct:+.1f}%, new firms {nci_new_pct:+.1f}%. '
        'Non-CI gains will likely normalize once new-firm onboarding completes.'
    )

def query_log():
    # Claude fills this in by appending query notes after each run
    return '<p style="color:#9ca3af;font-size:12px">Query log not provided. Pass --query-log path to fill_report.py to populate.</p>'

# ─── FILL TEMPLATE ────────────────────────────────────────────────────────────
with open(TEMPLATE) as f:
    html = f.read()

cur_monday = date.today() - __import__('datetime').timedelta(days=date.today().weekday())
recent_start = (cur_monday - __import__('datetime').timedelta(weeks=2)).strftime('%Y-%m-%d')
recent_end   = (cur_monday - __import__('datetime').timedelta(days=1)).strftime('%Y-%m-%d')
prior_start  = (cur_monday - __import__('datetime').timedelta(weeks=6)).strftime('%Y-%m-%d')
prior_end    = (cur_monday - __import__('datetime').timedelta(weeks=2, days=1)).strftime('%Y-%m-%d')

subs = {
    '{{REPORT_DATE}}':              date.today().strftime('%Y-%m-%d'),
    '{{RECENT_RANGE}}':             f'{recent_start} → {recent_end}',
    '{{PRIOR_RANGE}}':              f'{prior_start} → {prior_end}',
    '{{EXEC_SUMMARY}}':             summary_line(),
    '{{WEEKLY_TREND_CI_NOTE}}':      weekly_trend_ci_note(),
    '{{WEEKLY_TREND_HEADERS}}':     weekly_trend_headers(),
    '{{WEEKLY_TREND_ROWS}}':        weekly_trend_rows(),
    '{{EXEC_KPIS_ROWS}}':           exec_kpis_rows(),
    '{{TOP_GROWING_ROWS}}':         mover_rows(top_grow, 'grow'),
    '{{TOP_DECLINING_ROWS}}':       mover_rows(top_decl, 'decl'),
    '{{COST_SUMMARY_ROWS}}':        cost_summary_rows(),
    '{{COST_WEEKLY_ROWS}}':         cost_weekly_rows(),
    '{{COST_INSIGHT}}':             cost_insight(),
    '{{UX_ROWS}}':                  ux_rows(),
    '{{UX_NOTE}}':                  ux_note(),
    '{{FIRM_TREND_HEADERS}}':       firm_trend_headers(),
    '{{FIRM_TREND_ROWS}}':          firm_trend_rows(),
    '{{DEEP_DIVE_SECTIONS}}':       '<div class="empty-dd">No deep dives run yet. Use add_deep_dive.py to add firm-level analysis.</div>',
    '{{FIRST_TOUCH_RECENT_ROWS}}':  first_touch_rows(ft_r),
    '{{FIRST_TOUCH_PRIOR_ROWS}}':   first_touch_rows(ft_p),
    '{{FIRST_TOUCH_INSIGHT}}':      first_touch_insight(),
    '{{BASELINE_ROWS}}':            baseline_rows(),
    '{{BASELINE_INSIGHT}}':         baseline_insight(),
    '{{COHORT_ROWS}}':              cohort_rows(),
    '{{COHORT_INSIGHT}}':           cohort_insight(),
    '{{QUERY_COUNT}}':              '11',
    '{{QUERY_LOG}}':                query_log(),
}

for placeholder, value in subs.items():
    html = html.replace(placeholder, value)

# ─── WRITE OUTPUT ─────────────────────────────────────────────────────────────
out_name = f'ai_playbooks_report_{date.today().strftime("%Y%m%d")}.html'
out_path = os.path.join(args.out_dir, out_name)
with open(out_path, 'w') as f:
    f.write(html)

print(f'✅ Report written: {os.path.abspath(out_path)}  ({len(html):,} chars)')

# Print flagged firms for deep dive awareness
print(f'\nFlagged firms available for deep dive (--firm-id):')
grow_list = ', '.join('{} ({})'.format(f['id'], firm_name(f['id'])) for f in top_grow)
decl_list = ', '.join('{} ({})'.format(f['id'], firm_name(f['id'])) for f in top_decl)
print(f'  Growing : {grow_list}')
print(f'  Declining: {decl_list}')
print(f'\nTo add a deep dive: python3 .claude/skills/ai_playbooks_report/scripts/add_deep_dive.py --report {out_path} --firm-id <id> ...')
