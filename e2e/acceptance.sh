#!/usr/bin/env bash
#
# EPIC-001 end-to-end acceptance harness.
#
# Drives the REAL orchestrator (src/config.ts) against a freshly scaffolded fixture
# repo with the ticketing command files + a real local bare git remote. The external
# CLIs the loop shells out to (claude / codex / gh) are replaced with shims on PATH
# that honor their real contracts; git is REAL (real worktrees, commits, pushes).
#
# This is hermetic, free, and reversible — it makes no changes to any GitHub repo —
# yet exercises the real worktree → /ticket-start → build/verify → review →
# /ticket-close → push → merge-gate flow and proves the four EPIC-001 criteria:
#   1. clean ticket runs end to end and auto-merges (green + low-risk)
#   2. a /ticket-close refusal (unchecked AC) is left in-progress + flagged, not merged
#   3. a high-risk diff (protected path) opens a PR instead of auto-merging
#   4. the loop never pushes a still-in-progress ticket
#
# Usage: bash e2e/acceptance.sh
# `set -e` so a broken scaffold/shim aborts loudly instead of a scenario passing
# on a half-built fixture. (ok/bad always return 0, so assertions never abort.)
set -euo pipefail

REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/config.ts"
PASS=0
FAIL=0

note() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

# --- shim CLIs (claude / codex / gh); behavior switches on $SCENARIO ----------
make_shims() {
  local bin="$1"
  mkdir -p "$bin"

  cat > "$bin/claude" <<'SH'
#!/usr/bin/env bash
# Mimics `claude -p "<command-or-prompt>"`.
prompt="${2:-}"
case "$prompt" in
  *"/ticket-start"*) echo "started ${prompt}"; exit 0 ;;
  *"/ticket-close"*)
    if [ "${SCENARIO:-}" = "refuse" ]; then
      echo "Cannot close: acceptance criterion 'AC2' is still unchecked."; exit 1
    fi
    git add -A && git commit -q -m "close: ${prompt}" || true
    echo "closed ${prompt}"; exit 0 ;;
  *) # builder turn — make a real edit in the worktree
    if [ "${SCENARIO:-}" = "highrisk" ]; then
      mkdir -p migrations; echo "-- migration $(date +%s%N)" >> migrations/001_init.sql
    else
      echo "feature line $(date +%s%N)" >> feature.txt
    fi
    echo "implemented"; exit 0 ;;
esac
SH

  cat > "$bin/codex" <<'SH'
#!/usr/bin/env bash
# Mimics `codex exec [-m M] --json --output-schema <schema> -o <last-msg-file> <prompt>`
# (TICKET-011 structured contract): write the schema-shaped JSON verdict to the -o file.
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
case "${SCENARIO:-}" in
  escalate)   verdict='{"verdict":"ESCALATE","findings":"Ambiguous requirements."}' ;;
  reqchanges) verdict='{"verdict":"REQUEST_CHANGES","findings":"Found a problem."}' ;;
  *)          verdict='{"verdict":"APPROVE","findings":""}' ;;
esac
if [ -n "$out" ]; then printf '%s' "$verdict" > "$out"; fi
echo "codex-shim: wrote verdict"
exit 0
SH

  cat > "$bin/gh" <<'SH'
#!/usr/bin/env bash
# `pr checks` must emit ONLY JSON: the loop's exec captures stdout+stderr combined,
# and observeCi parses the whole blob.
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "checks" ]; then
  printf '[{"name":"shim-check","bucket":"pass"}]'
  exit 0
fi
echo "[gh-shim] gh $*"
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "merge" ]; then echo "MERGED" > "$GH_MARKER"; fi
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "create" ]; then echo "CREATED" >> "$GH_MARKER_PR"; fi
exit 0
SH

  chmod +x "$bin/claude" "$bin/codex" "$bin/gh"
}

# --- scaffold a fixture repo with the ticketing scaffold + one loop:true ticket
scaffold_repo() {
  local root="$1" remote="$2"
  git init -q -b master "$root"
  git -C "$root" config user.email loop@test.local
  git -C "$root" config user.name "Loop Test"

  # package.json whose `test` script honors $TEST_EXIT (default 0 = green).
  cat > "$root/package.json" <<'JSON'
{ "name": "fixture", "version": "0.0.0", "private": true,
  "scripts": { "test": "exit ${TEST_EXIT:-0}" } }
JSON

  # Ticketing command files — their presence is what the loop probes for.
  mkdir -p "$root/.claude/commands"
  echo "# /ticket-start" > "$root/.claude/commands/ticket-start.md"
  echo "# /ticket-close" > "$root/.claude/commands/ticket-close.md"

  # A real loop-ready ticket with spec + plan files on disk.
  local td="$root/docs/epics/EPIC-100-demo/tickets"
  mkdir -p "$td" "$root/docs/epics/EPIC-100-demo"
  echo "# spec" > "$root/docs/epics/EPIC-100-demo/spec-TICKET-100.md"
  echo "# plan" > "$root/docs/epics/EPIC-100-demo/plan-TICKET-100.md"
  cat > "$td/TICKET-100.md" <<'MD'
---
id: TICKET-100
title: Demo loop-ready ticket
status: planned
spec: docs/epics/EPIC-100-demo/spec-TICKET-100.md
plan: docs/epics/EPIC-100-demo/plan-TICKET-100.md
loop: true
depends-on: []
---
# TICKET-100
MD

  git -C "$root" add -A
  git -C "$root" commit -q -m "scaffold fixture"

  # Real local bare remote; point origin/HEAD at master so detectBaseBranch works.
  git init -q --bare "$remote"
  git -C "$root" remote add origin "$remote"
  git -C "$root" push -q -u origin master
  git -C "$root" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
}

# --- run one scenario; prints the loop output, returns it via global LAST_OUT --
run_scenario() {
  local scenario="$1" test_exit="$2"
  local work bin root remote
  work="$(mktemp -d)"; bin="$work/bin"; root="$work/repo"; remote="$work/remote.git"
  make_shims "$bin"
  scaffold_repo "$root" "$remote"
  export GH_MARKER="$work/merged"; export GH_MARKER_PR="$work/pr_created"

  # shellcheck disable=SC2086 — EXTRA_FLAGS is intentionally word-split (loop CLI flags).
  LAST_OUT="$(cd "$root" && SCENARIO="$scenario" TEST_EXIT="$test_exit" \
    PATH="$bin:$PATH" node --experimental-strip-types "$REPO_SRC" --once ${EXTRA_FLAGS:-} 2>&1)"
  LAST_MERGED="no"; if [ -f "$GH_MARKER" ]; then LAST_MERGED="yes"; fi
  LAST_PR="no"; if [ -f "$GH_MARKER_PR" ]; then LAST_PR="yes"; fi
  # Was the loop branch pushed to the remote?
  LAST_PUSHED="no"
  if git -C "$remote" show-ref --quiet refs/heads/loop/ticket-100; then LAST_PUSHED="yes"; fi
  rm -rf "$work"
}

# ============================ scenarios ======================================

note "Scenario 1 — clean ticket: expect end-to-end AUTO-MERGE"
# Autopilot for this scenario only: since TICKET-013 the shipped default is review/review,
# which (correctly) downgrades auto-merge to open-pr — under defaults this scenario's
# auto-merge assertions can never pass. Raising the ceiling here is the explicit risk
# acceptance the autonomy design requires, scoped to the one scenario that tests the
# green+approved+low-risk auto-merge path.
EXTRA_FLAGS="--autonomy-default autopilot --autonomy-ceiling autopilot"
run_scenario "clean" "0"
unset EXTRA_FLAGS
echo "$LAST_OUT" | sed 's/^/    | /'
echo "$LAST_OUT" | grep -q "auto-merge" && ok "decided auto-merge" || bad "did not auto-merge"
[ "$LAST_MERGED" = "yes" ] && ok "gh pr merge invoked" || bad "merge not invoked"
[ "$LAST_PUSHED" = "yes" ] && ok "branch pushed after close" || bad "branch not pushed"

note "Scenario 2 — /ticket-close refuses (unchecked AC): expect FLAG, no push"
run_scenario "refuse" "0"
echo "$LAST_OUT" | sed 's/^/    | /'
echo "$LAST_OUT" | grep -qi "ticket-close refused" && ok "flagged close refusal" || bad "no refusal flag"
[ "$LAST_PUSHED" = "no" ] && ok "did NOT push (left in-progress)" || bad "pushed a non-closed ticket"
[ "$LAST_MERGED" = "no" ] && ok "did NOT merge" || bad "merged a refused ticket"

note "Scenario 3 — high-risk diff (touches migrations/): expect OPEN PR, not merge"
run_scenario "highrisk" "0"
echo "$LAST_OUT" | sed 's/^/    | /'
echo "$LAST_OUT" | grep -qi "open-pr" && ok "decided open-pr" || bad "did not open a PR"
echo "$LAST_OUT" | grep -qi "high-risk" && ok "escalation reason is high-risk" || bad "reason not high-risk"
[ "$LAST_PR" = "yes" ] && ok "gh pr create invoked" || bad "PR was not created"
[ "$LAST_MERGED" = "no" ] && ok "did NOT auto-merge a high-risk diff" || bad "auto-merged high-risk"

note "Scenario 4 — verification never passes: expect FLAG, no close, no push"
run_scenario "clean" "1"
echo "$LAST_OUT" | sed 's/^/    | /'
echo "$LAST_OUT" | grep -qi "still failing" && ok "flagged exhaustion" || bad "no exhaustion flag"
[ "$LAST_PUSHED" = "no" ] && ok "did NOT push a still-in-progress ticket" || bad "pushed an in-progress ticket"

note "Scenario 5 — reviewer ESCALATEs: expect OPEN PR, no fix attempt, no merge"
run_scenario "escalate" "0"
echo "$LAST_OUT" | sed 's/^/    | /'
echo "$LAST_OUT" | grep -qi "open-pr" && ok "decided open-pr on ESCALATE" || bad "did not open a PR"
[ "$LAST_MERGED" = "no" ] && ok "did NOT merge an escalated ticket" || bad "merged an escalated ticket"

# ============================ summary ========================================
note "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
