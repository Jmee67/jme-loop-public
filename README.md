# jme-loop

jme-loop is a repo-local, unattended coding-agent loop. It lets you define work as
markdown epics and tickets, then runs a bounded build, verify, review, close, and merge
workflow with local Claude and Codex CLIs instead of a metered API.

The engine is intentionally thin. It sequences work, creates ticket worktrees, runs
provider-specific builder and reviewer steps, records evidence, and enforces gates. The
repo's file-based ticketing system remains the source of truth for what may run.

Useful background:

- [Architecture notes](./docs/architecture.md)
- [Project north star and invariants](./docs/project/context.md)
- [Ticketing system index](./docs/TICKETING_SYSTEM.md)
- [External repo bootstrap prompt](./docs/bootstrap-external-repo.md)
- [Conductor file bridge](./docs/conductor-bridge.md)

## Current Shape

jme-loop is a shared CLI that can be installed
once and used from any armed project repo:

```text
loop init -> loop discover -> loop doctor -> loop print-plan
          -> loop autoplan -> loop run -> loop explain-run
```

The loop now includes:

- Repo-local CLI entrypoint through `loop`, backed by this shared engine checkout.
- `loop init` installer that stamps only the ticketing payload into target repos.
- Read-only discovery of epics, tickets, planning debt, and backlog proposals.
- Doctor diagnostics with structured `PASS` / `WARN` / `STOP` checks.
- Build/review provider split: Claude can build while Codex reviews, or the reverse.
- Hard startup preflight for dependencies, ticketing scaffold, configured providers,
  connector config, GitHub CLI auth, and model health.
- `loop print-plan` dry explanation of what an epic run would do.
- `/epic-autoplan` and `loop autoplan` for spec/plan drafting and cross-provider review.
- Run evidence bundles under `.agent/runs/<run-id>/`.
- `loop explain-run latest|<run-id>` for post-run summaries and Conductor handoffs.
- Optional `.conductor/inbox` and `.conductor/outbox` file bridge.
- Security checks that reject unsafe artifact paths, malformed bridge files, broken
  provider config, missing dependency installs, and unsafe loop readiness state before
  ticket work starts.

## How The Loop Runs A Ticket

Each executable ticket runs in its own git worktree:

```text
scan loop-ready tickets
  -> create worktree
  -> /ticket-start
  -> execute the frozen plan
  -> run verification
  -> cross-provider review
  -> /ticket-close
  -> merge gate or PR handoff
  -> evidence bundle
```

The builder is the provider selected during `loop init`. The other provider reviews the
diff before close and push decisions. If the run is low-risk, locally verified, approved,
and has the required CI signal, the merge gate may merge automatically. Otherwise it
opens or leaves a PR for human review.

## Non-Negotiable Invariants

1. The loop consumes tickets; it does not invent execution work at run time.
2. A ticket is loop-ready only when `status` is `sketched` or `planned`, `spec` and
   `plan` point to existing repo-local files, and `loop: true`.
3. Interactive brainstorming is never run headless. Missing specs or plans are planning
   debt, not permission to guess.
4. Every completed ticket must go through `/ticket-close` before push. Do not bypass the
   pre-push guard.
5. Verification is the Iron Law: every "done" claim needs fresh verification output.
6. Risk controls win over automation. Unsafe, high-risk, broken, or ambiguous states stop
   or escalate instead of falling through.

## Requirements

- Node.js 22 or newer. The engine runs TypeScript directly with
  `node --experimental-strip-types`.
- `git`.
- Claude Code CLI authenticated locally.
- Codex CLI authenticated locally.
- GitHub CLI (`gh`) authenticated when the target repo has a remote and the loop may push,
  open PRs, or observe CI.
- A project repo using, or ready to receive, the markdown ticketing scaffold.
- Optional: [Conductor](https://conductor.build) as the review and handoff surface.

Install dependencies in this engine checkout before linking or running commands:

```bash
npm install
```

## Install Once, Use From Project Repos

Keep the engine outside the repos it operates on:

```bash
git clone https://github.com/Jmee67/jme-loop-public.git ~/.jme-loop
cd ~/.jme-loop
npm install
npm link
```

Then arm a project repo from inside that repo:

```bash
cd /path/to/project
loop init
loop discover
```

`loop init` installs or updates the minimal payload in the project repo: ticketing
commands, hooks, scripts, templates, and `.loop` config. It does not copy this engine's
source into the target repo.

During interactive init, choose the build provider:

- `Claude builds` means Codex reviews.
- `Codex builds` means Claude reviews.

The choice is saved in the target repo at `.loop/build-review.json`. Re-run `loop init`
to show the saved split, or `loop init --reconfigure` to change it deliberately.

Automation can target a repo explicitly:

```bash
loop init --repo /path/to/project
loop discover --repo /path/to/project
```

## Operator Workflow

Start with inspect-only commands:

```bash
loop discover
loop doctor EPIC-001
loop print-plan EPIC-001
```

Plan an epic only after reviewing discovery and doctor output:

```bash
loop autoplan EPIC-001
```

Run one ticket first:

```bash
loop run --once
```

Then inspect the latest evidence:

```bash
loop explain-run latest
loop explain-run latest --handoff
```

Common commands:

| Command | Purpose |
| --- | --- |
| `loop init [--reconfigure]` | Arm or update the current repo with loop payload. |
| `loop discover` | Read-only inventory of epics, tickets, readiness, and backlog proposals. |
| `loop doctor EPIC-XXX` | Validate environment, structure, bridge files, and ticket readiness. |
| `loop print-plan EPIC-XXX` | Explain selected tickets, command steps, risk, and blockers. |
| `loop autoplan EPIC-XXX` | Draft and review missing ticket specs/plans for an epic. |
| `loop run [--once] [--tickets N] [--dry-run]` | Execute loop-ready tickets. |
| `loop explain-run latest\|<run-id>` | Summarize a run evidence bundle. |

Every command also accepts `--repo /path/to/project` for launchd, cron, process managers,
or scripts that run outside the project directory.

## NPM Scripts In This Engine Repo

The linked CLI is the preferred project-repo interface. These scripts are still useful
when working directly inside the engine checkout:

```bash
npm run loop          # run the loop from the current repo
npm run loop:once     # process exactly one ticket
npm run loop:dry      # dry-run one ticket selection
npm run loop:install  # install ticketing payload into the current repo
npm run doctor -- --epic EPIC-001
npm run print-plan -- --epic EPIC-001
npm run autoplan -- EPIC-001
npm run coverage:epic
```

## Ticketing Model

The ticketing system is plain markdown in the target repo:

```text
docs/project/context.md
docs/epics/EPIC-XXX-*/epic.md
docs/epics/EPIC-XXX-*/tickets/TICKET-XXX-*.md
docs/epics/EPIC-XXX-*/spec-TICKET-XXX.md
docs/epics/EPIC-XXX-*/plan-TICKET-XXX.md
```

Tickets carry frontmatter with status, dependencies, optional `loop: true`, and pointers
to their spec and plan. The loop treats those files as contracts, not suggestions.

Lifecycle slash commands remain the canonical ticket operations:

| Command | Purpose |
| --- | --- |
| `/epic-create` | Write a falsifiable epic contract. |
| `/epic-plan` | Decompose an epic into ticket files. |
| `/epic-autoplan` | Batch draft and review ticket specs/plans. |
| `/ticket-gate` | Classify whether a ticket can follow the standard path. |
| `/ticket-start` | Start work and enforce the ticket gate. |
| `/ticket-log` | Append execution notes. |
| `/ticket-close` | Run the close cascade and commit the completed ticket. |
| `/epic-close` | Close an epic after all tickets are terminal. |
| `/audit` | Produce a read-only ranked findings backlog. |

## Autoplanning

`loop autoplan EPIC-XXX` turns sketched tickets into loop-ready work when they can be
planned safely:

1. The drafter creates a spec and implementation plan from the epic, ticket, project
   context, and dependency siblings.
2. The reviewer provider returns `APPROVE`, `REQUEST_CHANGES`, or `ESCALATE`.
3. Approved tickets are written to disk, marked `status: planned`, and released with
   `loop: true`.
4. Escalated or exhausted tickets stay sketched with a human-readable reason.

Autoplanning is idempotent. Re-running it focuses on tickets that are still sketched. It
does not run interactive brainstorming headless and does not release escalated work.

## Safety And Diagnostics

The loop stops before spending model calls or creating worktrees when it detects unsafe
state. Current checks include:

- Missing `node_modules` for the target repo or first-level package directories.
- Missing `/ticket-start` or `/ticket-close` scaffold.
- Invalid ticket frontmatter, missing spec/plan files, absolute paths, or path traversal.
- Broken `.loop/build-review.json`.
- Missing or unauthenticated configured builder/reviewer provider.
- Hanging or failed Claude/Codex health probes.
- Missing or unauthenticated `gh` when the repo has a remote.
- Invalid connector configuration.
- Malformed or schema-invalid `.conductor` bridge files.

Use these before execution:

```bash
loop discover
loop doctor EPIC-XXX
loop doctor EPIC-XXX --json
loop print-plan EPIC-XXX
```

`loop run --dry-run` logs intended execution without running builders. `loop run
--preflight-only` validates real tool health and exits.

## Evidence And Handoff

Every run writes durable artifacts under:

```text
.agent/runs/<run-id>/
  summary.md
  decision-log.json
  evidence.json
  evidence.md
```

`evidence.json` uses the `run-evidence.v1` schema and records selected tickets, processed
tickets, command outcomes, plan hash, worktree path, changed files, verification, review,
PR action, final outcome, and links to logs.

Inspect the latest run:

```bash
loop explain-run latest
loop explain-run latest --json
```

Generate a Conductor handoff from the same evidence:

```bash
loop explain-run latest --handoff
```

When `.conductor/` exists, the optional file bridge uses:

```text
.conductor/inbox/   # requests to the loop
.conductor/outbox/  # run handoff files from the loop
```

The bridge is file-only: no network calls, no environment-derived content, safe
repo-relative artifact paths only, and atomic outbox writes.

## Development

Run the engine checks:

```bash
npm run typecheck
npm test
npm run verify
```

House conventions:

- TDD: failing test, minimal implementation, refactor.
- Prefer immutable data and pure logic with injected effects.
- Keep files focused; extract helpers before modules become too large.
- Handle errors loudly or degrade explicitly.
- Validate all CLI output, file content, config, and external data at boundaries.
- Keep secrets and magic values out of code; use config with documented defaults.
- `npm run verify` must be green before a commit.

## Repository Layout

```text
bin/loop.mjs              linked CLI shim
src/                      TypeScript engine, CLI, runners, gates, diagnostics
templates/                install payload copied into target repos
docs/project/             slow-moving context and coordination notes
docs/epics/               repo-local epics, tickets, specs, and plans
docs/audit/               published audit findings
docs/research/            research notes and skill grafts
scripts/                  local hooks and utility scripts
e2e/                      acceptance script
```

## Bootstrap Prompt

When setting up a different project repo from a coding-agent workspace, use the prompt in
[docs/bootstrap-external-repo.md](./docs/bootstrap-external-repo.md). It tells the agent
to locate or clone this engine outside the project, run `npm link`, arm the project with
`loop init`, and stop after discovery until you approve planning or execution.
