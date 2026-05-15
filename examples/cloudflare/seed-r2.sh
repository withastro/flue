#!/usr/bin/env bash
# Seed the R2 bucket used by skills-from-r2.ts with a sample skill.
#
# Run this once before exercising the agent. The agent reads from
# `.agents/skills/spam-filter/SKILL.md` after hydration, so the bucket
# needs an object at that key.
#
# Usage:
#   ./seed-r2.sh                       # seeds the remote dev bucket
#   BUCKET=prod ./seed-r2.sh           # seeds the remote prod bucket
#   REMOTE=0 ./seed-r2.sh              # seeds wrangler's local R2 store
#
# Requires pnpm dependencies installed and wrangler authenticated.
set -euo pipefail

BUCKET="${BUCKET:-dev}"
REMOTE="${REMOTE:-1}"
case "$BUCKET" in
  dev)  BUCKET_NAME="flue-example-knowledge-base-dev" ;;
  prod) BUCKET_NAME="flue-example-knowledge-base" ;;
  *)    echo "BUCKET must be 'dev' or 'prod' (got: $BUCKET)" >&2; exit 1 ;;
esac

SKILL_KEY=".agents/skills/spam-filter/SKILL.md"

# Use a tempfile so quoting stays sane.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<'EOF'
---
name: spam-filter
description: Classify a message as spam or not spam, with confidence and reasoning.
---

You are a spam-classification skill.

The message to classify is in `{{message}}`. Return a structured verdict:

- `spam`: true if the message is unsolicited bulk, fraudulent, or
  malicious; false if it's legitimate correspondence.
- `confidence`: "low" / "medium" / "high" based on how clear the
  signals are.
- `reasoning`: one or two sentences explaining the decision. Cite
  specific phrases or patterns from the message.

Heuristics that strongly indicate spam:
- Urgency ("URGENT", "ACT NOW", excessive ALL CAPS)
- Free prizes, lotteries, or "you won" claims
- Suspicious shortened URLs (bit.ly, tinyurl) without context
- Requests for sensitive information (passwords, SSNs, account numbers)
EOF

echo "Uploading $SKILL_KEY to $BUCKET_NAME..."
REMOTE_FLAG=()
if [[ "$REMOTE" != "0" ]]; then
  REMOTE_FLAG=(--remote)
fi
pnpm exec wrangler r2 object put "$BUCKET_NAME/$SKILL_KEY" --file "$TMP" ${REMOTE_FLAG+"${REMOTE_FLAG[@]}"}
echo "Done."
