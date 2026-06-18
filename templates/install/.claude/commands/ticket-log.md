---
description: Append a dated Execution log entry to the current ticket. Enforces "decision or invalidated assumption" rule.
argument-hint: TICKET-XXX (optional — inferred from recent context if omitted)
---

Append a new entry to the Execution log section of the ticket.

The entry must record either:

- a **Decision** made during implementation (with Rationale and Consequence), or
- an **Invalidated assumption** (citing which epic assumption by number, what replaces it, and the consequence).

If neither applies, **do not write an entry**. Tell the user the log was skipped and why — the log is signal-dense by design, and narrating code changes belongs in the commit message instead.

Format:

```
### YYYY-MM-DD
- **Decision:** ...
- **Rationale:** ...
- **Consequence:** ...
```

or

```
### YYYY-MM-DD
- **Invalidated assumption:** Epic assumption #N — "<quoted text>"
- **Consequence:** ...
```

Rules:

- Use today's date as the header.
- The log is append-only. Do not modify existing entries.
- After writing, update the ticket's `updated:` frontmatter field.
