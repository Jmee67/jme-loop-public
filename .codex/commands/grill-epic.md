---
description: Interactively interrogate an epic to capture operator intent as observable behaviors. Codex-readable equivalent of `.claude/commands/grill-epic.md`.
argument-hint: EPIC-XXX
---

# grill-epic for Codex

Use this when the operator asks to grill an epic from Codex. It mirrors the Claude slash command
`/grill-epic EPIC-XXX`, but it is plain instructions rather than a Claude command.

This workflow is **interactive only**. Do not run it headless. Do not invent behaviors the operator
did not affirm.

## Inputs

- Epic id: `EPIC-XXX`
- Epic file: `docs/epics/EPIC-XXX-*/epic.md`
- Project context: `docs/project/context.md`

## Procedure

1. Read the epic file and `docs/project/context.md`. Note existing `behaviors:` frontmatter and the
   `## Behaviors` section, if present. This workflow is re-runnable; do not clobber prior behavior
   IDs.
2. Grill one behavior at a time. Ask what the operator should be able to do, what should be visible
   immediately afterward, what the important empty/error/boundary cases are, and what would make the
   operator say "yes, that's it."
3. Keep each thread focused on operator-observable behavior, not implementation. Each final behavior
   must be one plain-language sentence in the form: "I can do X and see Y."
4. If the answers reveal two separate features, stop and tell the operator to split the work into a
   second epic before continuing.
5. Allocate behavior IDs sequentially. Never reuse IDs. If the epic already has live behaviors up to
   `B3`, new behaviors start at `B4`.
6. Assemble proposed changes but do not write yet:
   - Update frontmatter `behaviors: [B1, B2, ...]`.
   - Update or create `## Behaviors`, with one `B#:` line per behavior.
   - Reconcile `## Success criteria` so each behavior has observable success coverage.
   - If `## User story` or `## Success criteria` is missing, propose creating it from the grilling.
7. Show the proposed diff and wait for explicit confirmation.
8. After confirmation, write the epic file, set `updated:` to today's date, and commit with:
   `feat(EPIC-XXX): capture N behaviors`.
9. Final handoff: "Behaviors captured. Run `/epic-plan EPIC-XXX` next — it will check that every
   behavior is covered by a ticket and fix any gaps."

## Guardrails

- Never run this workflow headless.
- Never invent a behavior that the operator has not affirmed.
- Never accept purely internal implementation phrasing such as "uses a queue" as a behavior; ask
  what the operator will observe.
- The operator controls depth. If they say "good enough", "move on", or similar, stop that thread
  and move to the next behavior.
