---
description: Triage a single ticket — recommend standard or brainstorm path — and write the appropriate ticket structure based on grounded reading of codebase, history, and siblings. Also called by /epic-plan subagents during batch decomposition. Use whenever a ticket needs to be triaged, re-triaged, or its design approach reconsidered (e.g. "gate this ticket", "should this ticket be brainstormed", "flesh out TICKET-XXX").
argument-hint: TICKET-XXX
---

Triage and flesh out ticket $ARGUMENTS.

1. **Load the gate rules.** Read `.claude/skills/ticket-gate/SKILL.md` for the triage questions, decision matrix, and Branch A / Branch B file shapes.

2. **Read priors** in parallel:
   - The ticket file itself (currently a skeleton with `## Intent`, or an existing ticket being re-triaged).
   - The parent `epic.md`.
   - `CLAUDE.md` and `docs/project/context.md`.
   - All sibling tickets in this epic.
   - Each ticket listed in the ticket's `depends-on` frontmatter.

3. **Search for existing patterns** in parallel:
   - All specs under `docs/superpowers/specs/`.
   - Decision records under `docs/epics/*/decisions/` and `docs/project/decisions/`.

4. **Read recent code history** for areas relevant to the ticket intent. Use `git log --oneline -- <relevant-paths>` to find recent commits that touched the same surface.

5. **Run triage.** Answer three questions explicitly and capture the evidence behind each answer:
   - **Q1**: Does an existing spec or established pattern already cover this ticket's design? "Adjacent" is not enough — only count yes if the existing artefact materially answers the design questions.
   - **Q2**: Is there one obvious correct approach, or are there 2+ plausible approaches with non-trivial trade-offs?
   - **Q3**: Does this ticket define or change a contract other tickets/code consume? (Data shape, function signature, env var, URL pattern, event name, schema, type, route.)

6. **Assess complexity (when-NOT-to-plan).** Before applying the matrix, judge whether this is a *straightforward small/local implementation* — small and local (≈ one file / under ~200 LOC), one obvious correct approach, and no new contract (the same signals Q1–Q3 already gathered, now read for size). **State the assessment and the one-line reasoning** behind it (what made it straightforward, or not), so the call is visible in the gate's output. Source rubric: `docs/research/skill-grafts/planning-workflow/SKILL.md`, "When NOT to Use This Skill."
   - **Straightforward small/local** → recommend **minimal planning**: plan inline / lightweight and skip the full spec+plan round, because the planning overhead would exceed the implementation cost. State this recommendation with its reasoning.
   - **Not straightforward** → proceed to the decision matrix below unchanged. The complexity assessment is a stated layer *in front of* the matrix, never a replacement for it; the matrix still governs the standard/inherited/brainstorm choice.

7. **Apply the decision matrix** (from the ticket-gate skill):
   - Q3 = yes → recommend brainstorm
   - Q1 = no AND Q2 = no → recommend brainstorm
   - Q1 = yes AND Q2 = yes AND Q3 = no → recommend standard, inheriting (set `spec:` frontmatter pointer to the existing spec)
   - Otherwise → recommend standard

8. **Surface the recommendation.**
   - **Invoked directly by the user**: present the recommendation with the rationale (which Qs triggered, with one-line evidence per Q) and ask the user to confirm or override.
   - **Invoked by a `/epic-plan` subagent**: proceed with the recommendation. The user reviews the batch summary during `/epic-plan`'s summary step.

9. **Write the ticket structure** per the gate skill's Branch A or Branch B file shape (preserve frontmatter beyond the gate-specific fields):
   - **Branch A — Standard**: rewrite body with `## Scope`, `## Acceptance criteria`, `## Context`, `## Execution log`, `## Cascade`. Add frontmatter: `gate-decision: standard` (or `inherited` if a `spec:` pointer was set), `gate-rationale: <one-line>`, `spec: <path>` if inheriting. Preserve any `covers:` array the skeleton already carries (the behavior IDs this ticket delivers, assigned by `/epic-plan`); if the body's acceptance criteria make it deliver a behavior not yet listed, add that behavior's ID to `covers:`.
   - **Branch B — Brainstorm**: rewrite body with `## Sketch`, `## Cascade dependencies`, `## Brainstorm recommended`, `## Execution log`, `## Cascade`. Add frontmatter: `gate-decision: brainstorm`, `gate-rationale: <one-line>`. Preserve any `covers:` array the skeleton already carries (the behavior IDs this ticket delivers, assigned by `/epic-plan`).

10. **Status remains `sketched`** in both branches. `/epic-plan` set it; `/ticket-gate` does not change it. The transition to `in-progress` happens at `/ticket-start`.

NEVER invoke `superpowers:brainstorming` from this command. The gate is a triage-and-write step only. Brainstorming is deferred to `/ticket-start` so design exploration happens at the moment the ticket is picked up, with full context and user attention.
