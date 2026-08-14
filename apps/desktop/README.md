# Laborer mission control

Laborer's mission-control pair lets an operator manage local git-worktree Workspaces and observe parallel coding agents:

- [`apps/web/`](../web/) is the React 19 interface.
- [`apps/desktop/`](./) is its thin Electron shell, including windows, tray integration, updates, and secure renderer bridging.

For the complete monorepo layout and workspace-wide commands, start with the [root README](../../README.md).

## Capabilities

- Git-worktree Workspace creation, setup, reconciliation, and pull-request tracking.
- Persistent tmux-style layouts containing terminal panes, diffs, and file trees.
- Long-lived PTY terminals with independent ownership, WebSocket RPC transport, scrollback, restoration, and agent-status notifications.
- A shared task board and SQLite state used by both local mission control and registered coding workflows.

The Diff Viewer is read-only. Terminal panes are views: closing or moving one does not stop the terminal it displays.

## Architecture

During development, Turborepo watches the web, desktop, server, terminal, and file-watcher workspaces. The standalone daemon owns backend capability, and both the browser and Electron renderer use its same-origin WebSocket RPC endpoint. The detached pty host preserves terminals across daemon restarts.

Shared domain types and Effect RPC contracts live in [`packages/shared/`](../../packages/shared/). The sandboxed Electron renderer receives a narrow preload bridge for native chrome; renderer-to-service communication uses typed daemon RPC.

## Development

Run commands from the repository root. Install dependencies once, then start the complete mission-control pair:

```sh
bun install
bun run dev
```

To run only the Vite interface (without mission-control utility processes):

```sh
bun run --cwd apps/web dev
```

Useful checks:

```sh
bun run typecheck
bun run test
bun run format
```

Build the macOS DMG with `bun run dist:desktop:dmg`.

## Task MCP

External local agents can manage board tasks through the stdio MCP server at `~/.local/bin/laborer-mcp`. The desktop app installs or refreshes this command when it launches; agents can use it while the app is closed. The invoking MCP client must provide Node.js 24 or newer on `PATH` and configure the executable as a command, not an HTTP URL.

## Project configuration

A repository managed by mission control can provide `laborer.json`:

```json
{
  "setupScripts": ["bun install"],
  "agent": "opencode2"
}
```

Supported agent values are `opencode2`, `claude`, and `codex`. Existing `opencode` values migrate to `opencode2` when read.

## Manual cleanup from older releases

The application uses the shared `laborer.sqlite` database. Obsolete LiveStore files are never removed during startup, install, update, or build. Preview and explicitly delete only those enumerated files from the repository root:

```sh
bun run cleanup:livestore --dry-run
bun run cleanup:livestore --delete
```

Removed Docker and Daytona execution resources are also left to their owning tools. Delete unneeded containers, images, cloud sandboxes, snapshots, and generated SSH entries directly; cloud resources may continue to incur charges.
