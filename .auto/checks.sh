#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run check >/tmp/phases-autoresearch-check.log 2>&1 || { tail -80 /tmp/phases-autoresearch-check.log; exit 1; }
npm run build >/tmp/phases-autoresearch-build.log 2>&1 || { tail -80 /tmp/phases-autoresearch-build.log; exit 1; }
