# Laborer

This repository contains two independent application roots:

- [`current/`](./current/) — the existing Laborer Bun/Turborepo application.
- [`next/`](./next/) — the primary Slack-native Laborer.

Each application owns its package manifest, lockfile, dependencies, and build
configuration. Run package-manager commands from the relevant application
directory so dependencies do not leak between the two apps.

The Slack-native application stores runtime state beneath each Laborer root's
`.laborer-runtime` directory. Its Soul, Workspace-memory, and User-profile
Markdown live outside repositories in `~/.config/laborer` (or
`$XDG_CONFIG_HOME/laborer` for an absolute, nonblank `XDG_CONFIG_HOME`). Shared
mutation locks live separately in `~/.local/state/laborer` (or
`$XDG_STATE_HOME/laborer`).

## Existing application

```bash
cd current
bun install
bun run dev
```
