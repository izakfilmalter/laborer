# Laborer

This repository contains two independent application roots:

- [`current/`](./current/) — the legacy Laborer desktop mission-control application.
- [`next/`](./next/) — the primary Slack-native Laborer runtime.

Each application owns its package manifest, lockfile, dependencies, and build
configuration. Run package-manager commands from the relevant application
directory so dependencies do not leak between the two apps.

The Slack runtime has one authoritative daemon: `bun run --cwd next start:slack`.
It uses `chat` + `@chat-adapter/slack` for the entire Slack plane and ACP with
OpenCode 2 for its Conversation agent. There is no alternate production
receiver or legacy Conversation fallback. Credential-isolated canaries are
manual evidence gates, not alternate architectures.

Implementation Actions continue through the OpenCode HTTP adapter. They inherit
the user's OpenCode permission policy: Laborer does not install wildcard allows
when creating implementation sessions. Before reusing a historical session,
Laborer removes only exact wildcard-allow entries installed by the old adapter;
all other session rules remain ordered and unchanged. See the
[`next` runtime documentation](./next/README.md) for configuration, permission,
and recovery details.

The Slack-native daemon stores all runtime state under
`~/.local/state/laborer` (or an absolute, nonblank `$XDG_STATE_HOME/laborer`),
partitioned by authenticated Slack workspace. Its Soul, Workspace memory, and
User-profile Markdown live outside repositories in `~/.config/laborer` (or an
absolute, nonblank `$XDG_CONFIG_HOME/laborer`). See the
[`next` runtime documentation](./next/README.md) for the exact composition and
state layout.

## Existing application

```bash
cd current
bun install
bun run dev
```
