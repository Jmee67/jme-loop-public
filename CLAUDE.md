# CLAUDE.md — entry point for agents working in this repo

> **This file is a pointer, not a source of truth.** It exists so tools and skills that expect a
> conventional `CLAUDE.md` resolve to the real governance docs. Do not duplicate rules here — edit the
> authoritative source and let this file keep pointing at it.

## What this repo is

An **unattended coding-agent loop**: a thin TypeScript orchestrator that drives an existing
file-based ticketing system's slash commands to plan, build, test, review, and ship tickets with
minimal supervision. See `README.md` for setup.

## Where the rules actually live

| You need… | Read… |
|---|---|
| Invariants, house conventions, current direction (the "system rules") | [`docs/project/context.md`](docs/project/context.md) |
| Architecture notes and component breakdown | [`docs/architecture.md`](docs/architecture.md) |
| How tickets/epics flow (the "ticketing system") | [`docs/TICKETING_SYSTEM.md`](docs/TICKETING_SYSTEM.md) — an index; the commands themselves are the contract |
| Per-epic contracts and tickets | `docs/epics/EPIC-*/` |

## Non-negotiables (authority: `docs/project/context.md` §Invariants)

These are summarized for orientation only — `context.md` is authoritative if anything here drifts:

1. The loop **consumes** tickets; it never invents them. Authoring is a human capture activity.
2. A ticket is **loop-ready iff** `status ∈ {sketched, planned}` **AND** `spec`+`plan` exist **AND**
   `loop: true`. All three.
3. **Never** run `superpowers:brainstorming` headless — it's interactive.
4. **Always** `/ticket-close` before `git push`; **never** `--no-verify`.
5. **Risk-based merge:** green + approved + low-risk auto-merges; anything else opens a PR.

## House conventions for any code you write

TDD always · immutability over in-place mutation · small focused files (~200–400 lines, 800 max) ·
errors handled never swallowed · validate at boundaries · no hardcoded secrets/magic values ·
`npm run verify` green is the Iron Law. Full text and rationale: `docs/project/context.md`
§House conventions.
