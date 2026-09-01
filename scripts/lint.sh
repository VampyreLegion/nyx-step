#!/usr/bin/env bash
# Nyx-Step lint suite — happy path for both Python and JS.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── ruff (Python correctness: E9/F63/F7/F82) ──"
ruff check .

echo "── node --check (JS syntax across static/) ──"
for f in static/*.js static/vendor/*.js; do
  node --check "$f"
done
echo "All JS files parse cleanly."

echo "── pytest ──"
python -m pytest tests/ -q