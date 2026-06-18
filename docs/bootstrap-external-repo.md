# Bootstrap an External Repo

Use this when you are inside a project repo workspace and want to arm that repo with jme-loop.

The engine should live outside the project repo. `loop init` installs only the minimal payload into
the project: hooks, commands, scripts, and ticketing structure. Do not copy the full engine source
into the target repo.

## Copy-paste prompt for a project workspace

```text
Use this looping infrastructure: https://github.com/Jmee67/jme-loop-public

Set it up for this repo without copying the engine into this repo:
1. Clone or locate jme-loop outside this project repo.
2. In the jme-loop checkout, install dependencies and run `npm link`.
3. Return to this project repo.
4. Run `loop init`.
5. Run `loop discover`.
6. Report what is loop-ready, what has planning debt, and what backlog proposals were found.

Do not run `loop autoplan` or `loop run` until I approve.
```

## Operator commands

First install the shared engine once:

```bash
git clone https://github.com/Jmee67/jme-loop-public.git ~/.jme-loop
cd ~/.jme-loop
npm install
npm link
```

Then arm a project repo from inside that repo:

```bash
cd /path/to/project
loop init
loop discover
```

For a VPS, cron job, launchd job, or process manager, pass the target repo explicitly:

```bash
loop init --repo /path/to/project
loop discover --repo /path/to/project
```

## Approval gates

Start with inspect-only:

```bash
loop init
loop discover
```

After reviewing the discovery report, approve planning explicitly:

```bash
loop autoplan EPIC-001
```

After reviewing planned tickets, approve execution explicitly:

```bash
loop run --once
```

The loop-ready invariant still controls execution: a ticket is executable only when it has
`status` in `sketched` or `planned`, valid `spec` and `plan` files, and `loop: true`.

## Conductor workspace notes

- Run the setup from the project workspace directory, not from the jme-loop checkout.
- Use the jme-loop checkout only as the shared engine installation.
- If the project repo is already open in Conductor, do not clone the project again. Use the current
  workspace as the target repo.
- Discovery is read-only except for `loop init` installing or updating the minimal loop payload.
- Backlog inferred from local docs, TODOs, or GitHub issues is proposal output. It is not released to
  execution automatically.

## Expected result

After `loop discover`, the report should show:

- loop-native epics and tickets found in `docs/epics`;
- loop-ready tickets that can be executed;
- planning-debt tickets missing valid specs or plans;
- proposal backlog found from local docs or enabled connectors;
- skipped sources and remediation when credentials, policy, or structure are missing.

Only proceed to `loop autoplan` or `loop run` after the operator approves the next step.
