#!/usr/bin/env bash
# Run every test that needs nothing but Python 3, Node 22+ and Chrome.
#   tests/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "== Server and repository checks"
python3 -m unittest discover -s tests
echo "== Demo data"
node --test tests/demo.test.mjs | tail -n 9
echo "== Browser smoke test"
node tests/smoke.mjs
