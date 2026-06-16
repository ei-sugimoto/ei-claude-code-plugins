#!/usr/bin/env bash
# Read-only sanity check for cmux. Exits non-zero if the daemon isn't reachable.
set -euo pipefail

echo "== ping =="
cmux ping

echo
echo "== version =="
cmux version

echo
echo "== identify (caller / focused / socket) =="
cmux identify --json

echo
echo "== topology =="
cmux tree

echo
echo "OK: cmux daemon reachable and topology readable."
