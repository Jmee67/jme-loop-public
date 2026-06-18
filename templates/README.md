# Loop install payload

`npm run loop:install [targetRepo]` stamps these into a target repo (idempotent;
re-run is a no-op; a divergent file or hooks setup reports a conflict and stops):

| Stamped into the repo | Purpose |
| --- | --- |
| `.claude/commands/*.md` | Ticketing slash commands (`/ticket-start`, `/ticket-close`, …). |
| `.claude/settings.json` | Scoped headless allowlist; `git push` explicitly denied (the orchestrator owns push). |
| `scripts/check-in-progress-tickets.sh` | Invariant #4 backstop — blocks a push while a ticket is in-progress. |
| `.githooks/pre-push` | Runs the check script; activated via `git config --local core.hooksPath .githooks`. |

**Machine-level (NOT installed — validated by the startup preflight):** `codex` answers
under its configured model, `claude` answers headless, `gh` is authenticated when a remote
exists. See `src/preflight.ts`.

**Per-clone activation:** `core.hooksPath` is local git config, so a fresh clone must re-run
`npm run loop:install` to re-activate the hook.
