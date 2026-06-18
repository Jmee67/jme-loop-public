# Sample Epic

This directory shows the minimum shape of a project repo that jme-loop can inspect.

```text
docs/project/context.md
docs/epics/EPIC-001-example/epic.md
docs/epics/EPIC-001-example/tickets/TICKET-001-example.md
docs/epics/EPIC-001-example/spec-TICKET-001.md
docs/epics/EPIC-001-example/plan-TICKET-001.md
```

A real project should create its own context, epic, ticket, spec, and plan files. A ticket
is executable only when it has valid spec and plan files and `loop: true`.
