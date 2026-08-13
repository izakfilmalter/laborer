# Laborer

This repository is a Bun and Turborepo monorepo containing two applications:

- [`apps/desktop/`](./apps/desktop/) — the legacy Laborer desktop mission-control application.
- [`apps/bot/`](./apps/bot/) — the primary Slack-native Laborer runtime.

Shared packages live under [`packages/`](./packages/). Install dependencies and
run the main build, test, typecheck, and formatting commands from the repository
root.

The Slack runtime has one authoritative daemon: `bun run start:bot`.
It uses `chat` + `@chat-adapter/slack` for the entire Slack plane and ACP with
OpenCode 2 for its Conversation agent. There is no alternate production
receiver or legacy Conversation fallback. Credential-isolated canaries are
manual evidence gates, not alternate architectures.

Implementation Actions continue through the OpenCode HTTP adapter. They inherit
the user's OpenCode permission policy: Laborer does not install wildcard allows
when creating implementation sessions. Before reusing a historical session,
Laborer removes only exact wildcard-allow entries installed by the old adapter;
all other session rules remain ordered and unchanged. See the
[`bot` runtime documentation](./apps/bot/README.md) for configuration, permission,
and recovery details.

The Slack-native daemon stores all runtime state under
`~/.local/state/laborer` (or an absolute, nonblank `$XDG_STATE_HOME/laborer`),
partitioned by authenticated Slack workspace. Its Soul, Workspace memory, and
User-profile Markdown live outside repositories in `~/.config/laborer` (or an
absolute, nonblank `$XDG_CONFIG_HOME/laborer`). See the
[`bot` runtime documentation](./apps/bot/README.md) for the exact composition and
state layout.

## Development

```bash
bun install
bun run dev
```
