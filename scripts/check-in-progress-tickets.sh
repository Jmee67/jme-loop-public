#!/usr/bin/env sh
# Invariant #4 backstop: block a push while any ticket is still status: in-progress.
# The orchestrator must /ticket-close (which flips status away from in-progress) first.
set -eu
root=$(git rev-parse --show-toplevel)
matches=$(grep -rl '^status: in-progress' "$root/docs/epics" 2>/dev/null || true)
if [ -n "$matches" ]; then
  echo "pre-push blocked: ticket(s) still in-progress — run /ticket-close first:" >&2
  echo "$matches" >&2
  exit 1
fi
exit 0
