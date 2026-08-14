#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
node --check .auto/audit.mjs

port="${AUTORESEARCH_PORT:-4179}"
log_file="${TMPDIR:-/tmp}/phases-autoresearch-vite.log"
npm run dev -- --host 127.0.0.1 --port "$port" >"$log_file" 2>&1 &
server_pid=$!
cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT

for _ in {1..80}; do
  if curl --silent --fail "http://127.0.0.1:$port/" >/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then tail -40 "$log_file" >&2; exit 1; fi
  sleep 0.1
done

AUDIT_ORIGIN="http://127.0.0.1:$port" node .auto/audit.mjs
