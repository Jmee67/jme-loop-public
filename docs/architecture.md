# Architecture

jme-loop is a thin orchestration layer around a markdown ticketing workflow. The codebase
keeps durable project state in the target repository and uses local CLIs for model-backed
builder and reviewer work.

## Components

- `bin/loop.mjs` is the linked CLI shim.
- `src/cli.ts` resolves the target repository and dispatches subcommands.
- `src/init.ts` installs the ticketing payload into a target repo.
- `src/discover.ts`, `src/doctor.ts`, and `src/printPlan.ts` provide read-only readiness
  and execution previews.
- `src/autoplan.ts` drafts and reviews missing ticket specs and plans.
- `src/orchestrator.ts` coordinates loop execution.
- `src/executePlan.ts`, `src/reviewStep.ts`, and `src/mergeGate.ts` handle execution,
  review, and merge/PR decisions.
- `src/runStore.ts`, `src/comprehension.ts`, and `src/explainRun.ts` record and explain
  durable run evidence.

## Data Flow

1. A project repo contains `docs/project/context.md`, an epic, tickets, specs, and plans.
2. `loop discover` classifies ticket readiness without mutation.
3. `loop doctor` validates local environment, provider config, bridge files, and ticket
   structure.
4. `loop print-plan` explains selected tickets, expected commands, risk, and blockers.
5. `loop autoplan` can draft and review missing specs/plans for sketched tickets.
6. `loop run` selects loop-ready tickets, creates worktrees, runs the frozen plan,
   verifies, reviews, closes, and decides merge/PR handoff.
7. `loop explain-run` reads `.agent/runs/<run-id>/evidence.json` and renders a concise
   run summary.

## Safety Boundaries

- Work only starts from tickets that explicitly opt in with `loop: true`.
- Specs and plans must be repo-relative files inside the target repository.
- Startup preflight stops before model calls when dependencies, provider auth, ticketing
  scaffold, connectors, or bridge files are invalid.
- Run evidence stores summaries and redacted findings, not raw secrets.
- High-risk or ambiguous work escalates to review rather than auto-merging.
