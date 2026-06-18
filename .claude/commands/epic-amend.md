---
description: Amend an epic's scope, assumptions, or acceptance criteria with mandatory rationale and impact analysis across all child tickets.
argument-hint: EPIC-XXX
---

Amend epic $ARGUMENTS.

1. Read the epic's `epic.md` and every ticket file under that epic.
2. Ask the user what's changing and why. Do not proceed until you have both a clear change and a clear rationale.
3. Draft the proposed change as a diff against `epic.md`.
4. Walk every child ticket and for each one state explicitly whether the change affects its scope, acceptance criteria, or dependencies. For each affected ticket, propose the edit.
5. Draft a decision record at `docs/epics/<EPIC>/decisions/YYYY-MM-DD-<slug>.md` with the Context / Decision / Alternatives / Consequences format.
6. Show all proposed changes grouped by file. Wait for the user's explicit confirmation.
7. On confirmation, apply all changes in a single commit: `epic(EPIC-XXX): amend — <one-line summary>` with `docs:` trailer lines for each affected file.

Never amend an epic without writing the decision record. Never amend silently without walking every child ticket.
