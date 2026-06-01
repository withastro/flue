#!/usr/bin/env python3
"""
add_deep_dive.py — Inject a deep-dive block into an existing AI Playbooks report.

Reads pre-run check CSVs for a single firm and appends a formatted deep-dive
block into the {{DEEP_DIVE_SECTIONS}} / existing deep dive area of the report.

Usage (Claude calls this after running Check 1–4 queries for a firm):

    python3 .claude/skills/ai_playbooks_report/scripts/add_deep_dive.py \
        --report  ai_playbooks_report_20260326.html \
        --firm-id 3074 \
        --firm-name "Glenn Walters & Associates, PA" \
        --is-ci   False \
        --recent-pw 14.0 \
        --prior-pw  105.5 \
        --check1  /tmp/bq_check1.csv          \
        [--check2 /tmp/bq_check2.csv]         \
        [--check3 /tmp/bq_check3.csv]         \
        [--check4 /tmp/bq_check4.csv]         \
        [--root-cause "Matter volume decline"] \
        [--evidence "Distinct matters dropped from 19 to 2 over 4 weeks."] \
        [--csm-note "Escalate: single-user dependency observed."]

If --root-cause is provided, a green "Root cause found" callout is rendered.
If not, a yellow CSM escalation prompt is rendered using Check 1's csm_email.

The script modifies the report HTML file in-place, replacing the empty-dd
placeholder or appending after the last firm-block div.
"""

import argparse, csv, os, re
from datetime import date

p = argparse.ArgumentParser()
p.add_argument('--report',      required=True)
p.add_argument('--firm-id',     required=True, dest='firm_id')
p.add_argument('--firm-name',   required=True, dest='firm_name')
p.add_argument('--is-ci',       required=True, dest='is_ci')
p.add_argument('--recent-pw',   required=True, type=float, dest='recent_pw')
p.add_argument('--prior-pw',    required=True, type=float, dest='prior_pw')
p.add_argument('--check1',      default=None)
p.add_argument('--check2',      default=None)
p.add_argument('--check3',      default=None)
p.add_argument('--check4',      default=None)
p.add_argument('--root-cause',  default=None, dest='root_cause')
p.add_argument('--evidence',    default=None)
p.add_argument('--csm-note',    default=None, dest='csm_note')
args = p.parse_args()

def load(path):
    if not path or not os.path.exists(path): return []
    with open(path) as f: return list(csv.DictReader(f))

check1 = load(args.check1)
check2 = load(args.check2)
check3 = load(args.check3)
check4 = load(args.check4)

# ─── Derive values ────────────────────────────────────────────────────────────
pct = (args.recent_pw - args.prior_pw) / args.prior_pw * 100 if args.prior_pw else None
direction = 'increase' if (pct or 0) > 0 else 'decrease'
pct_str = f'{pct:+.1f}%' if pct is not None else 'n/a'
badge = '<span class="badge-ci">CI</span>' if args.is_ci.lower() == 'true' else '<span class="badge-non-ci">Non-CI</span>'
arrow = '▲' if (pct or 0) > 0 else '▼'
cls   = 'up' if (pct or 0) > 0 else 'down'

# Extract CSM email from Check 1 CSV if available
csm_email    = 'unknown@evenuplaw.com'
account_type = None
is_active    = None
if check1:
    row = check1[0]
    csm_email    = row.get('csm_email', csm_email)
    account_type = row.get('account_type')
    is_active    = row.get('is_firm_active', 'True')

# ─── Build HTML block ─────────────────────────────────────────────────────────
lines = []
def o(s): lines.append(s)

o(f'<div class="firm-block" id="dd-{args.firm_id}">')
o(f'  <h3>{args.firm_name} (ID: {args.firm_id}) {badge} <span class="{cls}">{arrow} {pct_str}</span></h3>')
o(f'  <p style="color:#666;font-size:12px;margin-bottom:12px">'
  f'{args.recent_pw:.1f} runs/wk recent vs {args.prior_pw:.1f} runs/wk prior | '
  f'CSM: {csm_email} | Status: {account_type or "—"}</p>')

if args.root_cause:
    o(f'  <div class="callout-rc">')
    o(f'    <strong>Root cause: {args.root_cause}</strong>')
    if args.evidence:
        o(f'    <p>{args.evidence}</p>')
    o(f'  </div>')
else:
    # Determine what was ruled out
    ruled_out = []
    if check1:
        if account_type == 'Customer' and is_active == 'True':
            ruled_out.append('Contract churn/lifecycle issue (firm is active Customer)')
        elif account_type in ('Churned', 'Pending Churn'):
            ruled_out.append(f'Salesforce status: {account_type} — lifecycle event, not product issue')
    if check2: ruled_out.append('Matter volume change proportional to engagement shift')
    if check3: ruled_out.append('CI sync errors (no significant error rate found)')
    if check4: ruled_out.append('Single-user dominance')

    ruled_html = ''.join(f'<li>✗ {r}</li>' for r in ruled_out)
    dir_verb = 'increased' if direction == 'increase' else 'decreased'

    o(f'  <div class="callout-esc">')
    o(f'    <strong>⚠ No automated root cause identified — CSM follow-up recommended</strong>')
    o(f'    <p>CSM: {csm_email}</p>')
    o(f'    <p style="margin-top:6px">AI Playbooks engagement {dir_verb} {pct_str} '
      f'({args.recent_pw:.1f}/wk recent vs {args.prior_pw:.1f}/wk prior)</p>')
    if ruled_out:
        o(f'    <ul style="margin-top:8px">')
        o(f'      {ruled_html}')
        o(f'    </ul>')
    if args.csm_note:
        o(f'    <p style="margin-top:8px"><strong>Note:</strong> {args.csm_note}</p>')
    o(f'    <ul style="margin-top:8px">')
    o(f'      <li><strong>Recommended questions for {csm_email}:</strong></li>')
    o(f'      <li style="margin-left:16px">Recent changes to AI Playbooks setup at this firm (new templates, deleted playbooks)?</li>')
    o(f'      <li style="margin-left:16px">Product training or onboarding sessions in this period?</li>')
    o(f'      <li style="margin-left:16px">Staffing changes (attorneys leaving, new hires)?</li>')
    o(f'      <li style="margin-left:16px">Any reported technical issues?</li>')
    o(f'    </ul>')
    o(f'  </div>')

o('</div>')

block = '\n'.join(lines)

# ─── Inject into report ───────────────────────────────────────────────────────
if not os.path.exists(args.report):
    print(f'❌ Report not found: {args.report}')
    exit(1)

with open(args.report) as f:
    html = f.read()

EMPTY_PLACEHOLDER = '<div class="empty-dd">No deep dives run yet. Use add_deep_dive.py to add firm-level analysis.</div>'
LAST_DD_PATTERN   = re.compile(r'(</div>\s*)\n(</div><!--\s*\.section\s*-->|<div class="appendix">)', re.DOTALL)

# If still has the empty placeholder, replace it
if EMPTY_PLACEHOLDER in html:
    html = html.replace(EMPTY_PLACEHOLDER, block, 1)
# If firm already exists (re-run), replace its block
elif f'id="dd-{args.firm_id}"' in html:
    html = re.sub(
        rf'<div class="firm-block" id="dd-{args.firm_id}">.*?</div>\s*(?=\n)',
        block + '\n', html, flags=re.DOTALL
    )
# Otherwise append before the closing </div> of the section
else:
    # Find the deep dive section and append before its closing tag
    html = html.replace(
        '</div>\n\n<!-- ===== SECTION 7',
        block + '\n</div>\n\n<!-- ===== SECTION 7'
    )
    # Fallback: just append before appendix
    if block not in html:
        html = html.replace(
            '<div class="appendix">',
            block + '\n\n<div class="appendix">'
        )

with open(args.report, 'w') as f:
    f.write(html)

print(f'✅ Deep dive injected for {args.firm_name} (ID: {args.firm_id}) into {args.report}')
