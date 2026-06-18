# Ticketing system — index

> **This is an index, not a specification.** The ticket/epic lifecycle is encoded *operationally* in
> the slash-command skills listed below — the commands themselves are the executable contract. This
> file exists so the lifecycle is discoverable and so tools that expect `docs/TICKETING_SYSTEM.md`
> resolve. When behavior and this index disagree, the **skill is authoritative**; fix this index.

## The one rule everything hinges on

A ticket is **loop-ready iff** all three hold (authority: `docs/project/context.md` invariant #2):

```
status ∈ {sketched, planned}  AND  spec + plan both exist  AND  loop: true
```

Without `loop: true` a ticket is invisible to the loop. The loop **consumes** loop-ready tickets; it
never authors them (invariant #1).

## Artifact layout

```
docs/epics/EPIC-XXX-<slug>/
  epic.md            # the falsifiable epic contract (Goal, User story, Scope, Assumptions, Success criteria, Behaviors)
  decisions/         # grounded design decisions captured during planning
  tickets/           # per-ticket spec + plan files
```

## Lifecycle commands (the actual contract)

| Stage | Command | Does |
|---|---|---|
| Frame an epic | `/epic-create` | Authors a falsifiable epic contract; writes no tickets |
| Capture behaviors | `/grill-epic` | Interrogates intent into observable "I can do X and see Y" behaviors |
| Decompose | `/epic-plan` | Breaks an approved epic into a batch of tickets (one `/ticket-gate` per ticket) |
| Batch-plan | `/epic-autoplan` | Drafts each sketched ticket's spec+plan via a Claude↔Codex loop; releases the ones that pass |
| Amend scope | `/epic-amend` | Changes epic scope/assumptions/criteria with rationale + child-ticket impact |
| Close epic | `/epic-close` | Flips epic to `done` once every enrolled ticket is done |
| Triage one ticket | `/ticket-gate` | Recommends standard vs brainstorm path; writes the ticket structure |
| Start work | `/ticket-start` | Reads context, branches on gate decision, sets `in-progress` |
| Log a decision | `/ticket-log` | Appends a dated execution-log entry (decision or invalidated assumption) |
| Close a ticket | `/ticket-close` | Runs the cascade questions, proposes updates, commits |
| Find demand | `/audit` | Read-only repo/code audit → ranked `/epic-create` seeds under `docs/audit/` |

## Why there's no fuller spec here

By design, the orchestrator **drives the existing slash commands rather than reinventing them**
(`docs/project/context.md` §Shape of the thing). Re-specifying the commands in prose would create a
second source of truth to keep in sync. Read the skills for authoritative behavior; the full
architectural rationale is in `docs/architecture.md`.
