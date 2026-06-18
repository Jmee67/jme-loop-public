# Codex Grill Epic

Use this when working in Codex and the next step is the same interactive behavior-capture workflow as `/grill-epic EPIC-XXX`.

This workflow is interactive only. Never run headless. Never invent behaviors the operator did not affirm.

## Invocation

Ask the operator which epic to grill, then read:

- `docs/epics/EPIC-XXX-*/epic.md`
- `docs/project/context.md`
- Any existing `behaviors:` frontmatter and `## Behaviors` section

## Workflow

1. Grill one observable behavior at a time. Ask what the operator can do and what they should see immediately after.
2. Push on boundary cases only while the operator wants depth: empty input, wrong format, missing dependency, repeated run, or failure mode.
3. Convert every accepted behavior to plain language in the form `I can do X and see Y`.
4. Reject implementation-only phrasing. Restate it as operator-visible behavior.
5. Stop and recommend a separate epic if the answers split into two features.
6. Allocate behavior IDs sequentially as `B1`, `B2`, and so on. Never reuse IDs already present in the epic.
7. Prepare a proposed diff only after the operator has affirmed the behaviors:
   - update `behaviors: [B1, B2, ...]` frontmatter;
   - add or update `## Behaviors`;
   - reconcile `## Success criteria`;
   - create `## User story` or `## Success criteria` only if missing.
8. Show the proposed diff and wait for explicit confirmation before writing.
9. On confirmation, write the epic file, update its `updated:` date, and commit with `feat(EPIC-XXX): capture N behaviors`.

Final prompt after the commit: `Behaviors captured. Run /epic-plan EPIC-XXX next.`
