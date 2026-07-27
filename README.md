# Laborer

This repository contains two independent application roots:

- [`current/`](./current/) — the existing Laborer Bun/Turborepo application.
- [`next/`](./next/) — the primary Slack-native Laborer runtime.

Each application owns its package manifest, lockfile, dependencies, and build
configuration. Run package-manager commands from the relevant application
directory so dependencies do not leak between the two apps.

The Slack runtime has one production receiver: `bun run --cwd next start:slack`.
Its Conversation agent uses durable ACP; there is no alternate production
receiver or legacy Conversation fallback. `start:acp-canary` is a diagnostic
compatibility gate with isolated Slack credentials, not a second architecture.

Implementation Actions continue through the OpenCode HTTP adapter. They inherit
the user's OpenCode permission policy: Laborer does not install wildcard allows
when creating implementation sessions. Before reusing a historical session,
Laborer removes only exact wildcard-allow entries installed by the old adapter;
all other session rules remain ordered and unchanged. See the
[`next` runtime documentation](./next/README.md) for configuration, permission,
and recovery details.

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
