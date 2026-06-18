# Bootstrap an External Repo

Use this when you are inside a project repo workspace and want to arm that repo with jme-loop.

The engine should live outside the project repo. `loop init` installs only the minimal payload into
the project: hooks, commands, scripts, and ticketing structure. Do not copy the full engine source
into the target repo.

## Copy-paste prompt for a project workspace

```text
Use this looping infrastructure: https://github.com/Jmee67/jme-loop-public

Set it up for this repo without copying the engine into this repo:
1. Check whether `loop` is already installed with `which loop` and `npm ls -g --depth=0`.
2. If `~/.jme-loop` exists, inspect `git -C ~/.jme-loop remote -v`.
3. Do not overwrite, relink, or reuse an existing engine checkout that points at a different repo.
4. Clone or locate this public engine outside the project repo, preferably at `~/.jme-loop-public`.
5. In the public engine checkout, install dependencies.
6. Run `npm link` only if the global `loop` command is not already intentionally owned by another checkout.
7. Return to this project repo.
8. Run `loop init`.
9. Run `loop discover`.
10. Report what is loop-ready, what has planning debt, and what backlog proposals were found.

Do not run `loop autoplan` or `loop run` until I approve.
```

## Operator commands

First install the shared engine once:

```bash
which loop || true
npm ls -g --depth=0 | grep -Ei 'jme-loop|loop' || true
if [ -d ~/.jme-loop ]; then git -C ~/.jme-loop remote -v; fi

git clone https://github.com/Jmee67/jme-loop-public.git ~/.jme-loop-public
cd ~/.jme-loop-public
npm install
npm link
```

If `~/.jme-loop` already exists and points at another repository, leave it alone. `npm link`
registers a single global `loop` binary, so run it only when this public checkout should own
the global command.

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
