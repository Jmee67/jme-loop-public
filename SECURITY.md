# Security Policy

## Supported Versions

This project is early-stage. Security fixes target the default branch.

## Reporting A Vulnerability

Please do not open a public issue for a sensitive vulnerability. Instead, use GitHub's
private vulnerability reporting if available for this repository, or contact the
maintainer privately.

Include:

- affected version or commit;
- reproduction steps;
- expected and actual impact;
- any relevant logs with secrets removed.

## Secret Handling

Do not commit API keys, OAuth tokens, `.env` files, private keys, run artifacts, or local
workspace state. The default `.gitignore` excludes common runtime directories such as
`.agent/`, `.conductor/`, `.context/`, `.worktrees/`, and `node_modules/`.
