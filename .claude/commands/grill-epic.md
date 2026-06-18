---
description: Relentlessly interrogate the operator about an epic to capture intent as a traceable list of plain-language, observable behaviors ("I can do X and see Y"). Writes a ## Behaviors section + a behaviors:[B1,B2,…] frontmatter registry into the epic, and reconciles Success criteria. Interactive only — never run headless. Run after /epic-create and before /epic-plan.
argument-hint: EPIC-XXX
---

Grill the operator on epic $ARGUMENTS to capture observable behaviors. This command is
INTERACTIVE ONLY — it requires the operator present and must never run headless (the loop
never brainstorms headless; `docs/project/context.md` invariant #3).

1. **Read context.** Read `docs/epics/EPIC-XXX-*/epic.md` (Goal, User story, Scope) and
   `docs/project/context.md`. Note any existing `behaviors:` frontmatter / `## Behaviors`
   section — this command is re-runnable and must not clobber prior behaviors.

2. **Grill one behavior at a time.** For each thing the operator wants to be able to do, push
   on the branches they would otherwise skip — but only about BEHAVIOR the operator can
   observe, never implementation:
   - What exactly should be visible right after the action? ("How would you know it worked?")
   - Error / empty / boundary cases: ("What if the file is empty? Wrong format? Huge? What
     should you see in each case?")
   - The operator's own definition of done: ("What would make you say 'yes, that's it'?")
   Keep pushing a thread until the branch is resolved OR the operator hits the brake
   ("good enough", "move on", "edge case I don't care about"). On the brake, drop that thread
   and move to the next behavior. The operator controls depth at all times.

3. **Make each behavior observable.** Every behavior is one plain-language line in the form
   "I can do X and see Y" — something the operator could watch happen. Grill untestable
   phrasing into something checkable ("it should be fast" → "a 10MB file finishes in under 5
   seconds"). Reject behaviors that are pure implementation ("uses a queue") — restate them as
   what the operator observes.

4. **Scope guard.** If grilling reveals the epic is actually two features, STOP and point the
   operator to `/epic-create` to split into a second epic. Do not let the epic balloon.

5. **Allocate behavior IDs.** Assign sequential `B1`, `B2`, … IDs. IDs are NEVER reused: if the
   epic already has behaviors up to `B3`, new ones start at `B4`, even if an old one was
   deleted. The frontmatter `behaviors:` list is the registry of live IDs.

6. **Assemble the changes (do not write yet).**
   - A `## Behaviors` section in the epic body, one line per behavior: `B1: <sentence>`.
   - A `behaviors: [B1, B2, …]` frontmatter key (the registry of live IDs).
   - Reconcile `## Success criteria` so it matches the behaviors. **If the epic has no
     `## Success criteria` section** (older epics like EPIC-002 don't), CREATE it from the
     behaviors. Same for a missing `## User story` — create it from the grilling if the epic
     lacks one.

7. **Show the proposed change as a diff and wait for explicit confirmation** (same pattern as
   `/epic-create` step 7). Re-run handling: appended behaviors get fresh IDs; existing
   behaviors may be reworded but keep their IDs.

8. **On confirmation:** write the epic file, set `updated:` to today's date, and commit with
   message `feat(EPIC-XXX): capture N behaviors`.

9. **Final prompt:** "Behaviors captured. Run `/epic-plan EPIC-XXX` next — it will check that
   every behavior is covered by a ticket and fix any gaps."

NEVER run this command headless and NEVER invent behaviors the operator did not affirm — the
behavior list is the operator's contract for what the system will build.
