# Contributing

Thanks for taking a look at jme-loop.

## Development

Use Node.js 22 or newer.

```bash
npm ci
npm run verify
```

`npm run verify` runs TypeScript typechecking and the Node test suite.

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Update docs when commands, config, or workflow behavior changes.
- Do not include local run artifacts, credentials, or private project notes.

## Local Runtime Artifacts

The loop writes state into target repositories while running. Do not commit generated
runtime directories such as `.agent/`, `.conductor/`, `.context/`, or `.worktrees/`.
