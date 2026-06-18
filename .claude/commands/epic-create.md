---
description: Create a new epic. Runs a focused dialogue to author a falsifiable epic contract — Goal, User story, Scope, numbered Assumptions, observable Success criteria — without writing any tickets. Stops if the scope is actually multi-epic, if any Assumption is not falsifiable, or if any Success criterion is not observable. Use whenever the user wants to start a new top-level feature, asks to "create an epic", "open an epic", or describes a multi-ticket initiative that needs framing before decomposition.
argument-hint: <optional epic title or one-line idea>
---

You are creating a new epic.

1. Read `CLAUDE.md`, `docs/project/context.md`, and `docs/TICKETING_SYSTEM.md` for the system rules. List existing epics under `docs/epics/` for sibling awareness.

2. **Allocate the next free EPIC-XXX.** Scan directory names matching `docs/epics/EPIC-*`; take the highest existing number, add 1, and zero-pad to 3 digits.

3. **Scope sanity check.** If the user's intent describes multiple independent subsystems (e.g. "build a platform with chat, billing, and analytics"), stop and propose decomposing into multiple epics first. An epic is a single feature contract — anything that should ship as separate, independently-valuable units belongs in separate epics. Do not proceed until the user confirms this is one epic.

4. **Run the focused dialogue, one section at a time.** Confirm each section with the user before moving on to the next. Sections in order:
   - **Goal** — one sentence: "what does shipping this make true about the product?" If the user's first attempt isn't a single sentence, ask them to compress it. Multiple goals means multiple epics.
   - **User story** — three questions, one at a time:
     1. Who is the user this affects?
     2. What do they want to do?
     3. Why do they want to do it (what outcome)?
        Capture the answers in a dedicated `## User story` section between Goal and Why now.
   - **Why now** — context for the priority and timing.
   - **Scope** — explicit list of what's in.
   - **Out of scope** — explicit list of what's out.
   - **Assumptions** — numbered list. Each assumption must be testable. For each one, probe: "what would invalidate this?" If the user can't answer, the assumption is not falsifiable and needs to be rewritten or dropped.
   - **Success criteria** — observable / testable. Reject any criterion that can't be checked with a query, test, or user-visible outcome.
   - **Dependencies** — external teams, services, or preceding epics.
   - **Open questions** — should trend to zero as tickets complete.

5. **Self-review pass.** Read the assembled epic with fresh eyes:
   - Any TBDs, placeholders, or vague language? Fix inline.
   - Any Assumption that isn't falsifiable? Rewrite or drop.
   - Any Success criterion that isn't observable? Rewrite or drop.
   - Internal contradictions? Fix.

6. **Write the epic file.** Slugify the goal into a short kebab-case slug (3–5 words). Create:
   - Directory `docs/epics/EPIC-XXX-<slug>/`
   - File `docs/epics/EPIC-XXX-<slug>/epic.md`, with frontmatter populated: `id`, `title`, `status: planned`, `owner` (today's git user.name), `created` and `updated` set to today's date, `tickets: []`, and `behaviors: []` (the behavior registry, filled in later by `/grill-epic`).
   - Subdirectories `decisions/` and `tickets/` (empty; will be populated by future commands).

7. **Show the user the proposed file** as a diff. Wait for explicit confirmation.

8. **On confirmation:** stage and commit with message `feat(EPIC-XXX): create epic — <title>`.

9. **Final prompt:** "Epic created. Run `/grill-epic EPIC-XXX` next to capture observable behaviors before ticket planning."

Refuse to commit if Goal isn't one sentence, any Assumption isn't falsifiable, or any Success criterion isn't observable. Do not write tickets, sketches, or planning artefacts in this command — `/grill-epic` is the next step.
