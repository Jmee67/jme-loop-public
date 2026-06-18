# Project Context

jme-loop is an unattended coding-agent loop for repositories that manage work as markdown
epics, tickets, specs, and plans.

The engine is a TypeScript CLI that drives a repo-local ticketing scaffold. It does not
replace project judgment or ticket authoring; it sequences bounded execution, verification,
cross-provider review, run evidence, and merge/PR handoff.

## Invariants

1. The loop consumes tickets; it does not invent execution work at run time.
2. A ticket is loop-ready only when `status` is `sketched` or `planned`, `spec` and
   `plan` point to existing repo-local files, and `loop: true`.
3. Interactive brainstorming is never run headless. Missing specs or plans are planning
   debt, not permission to guess.
4. Completed tickets must pass through `/ticket-close` before push.
5. Verification evidence is required before a ticket is considered done.
6. Risk controls win over automation. Unsafe, high-risk, broken, or ambiguous states stop
   or escalate instead of falling through.

## Operating Model

Each executable ticket runs in its own git worktree. The configured builder provider
executes the frozen plan, the reviewer provider reviews the diff, and the merge gate
chooses between merge, PR handoff, or escalation based on verification, review, risk, and
CI evidence.

## House Conventions

- Use tests to define observable behavior before changing implementation.
- Prefer immutable data and pure logic with injected side effects.
- Keep modules focused and small enough to understand in one pass.
- Fail loudly with context, or degrade explicitly when a feature is optional.
- Validate CLI output, file content, config, and external data at boundaries.
- Keep secrets out of source and runtime artifacts.
- Run `npm run verify` before publishing changes.
