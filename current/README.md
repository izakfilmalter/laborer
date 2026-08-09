# Laborer

**Mission control for parallel AI coding agents.**

A local-first desktop application for orchestrating multiple AI coding agents in parallel. Laborer provides a tmux-style panel system where each pane is a live terminal running an AI agent, a diff viewer, a file tree, or a raw shell -- enabling you to monitor and interact with many agents working on different branches simultaneously.

```
+-------------------+-------------------+-------------------+
|  Agent: auth-fix  |  Agent: api-v2    |  Agent: tests     |
|  branch: fix/auth |  branch: feat/api |  branch: test/e2e |
|  port: 3101       |  port: 3102       |  port: 3103       |
|  [running]        |  [waiting]        |  [running]        |
+-------------------+-------------------+-------------------+
|          Diff Viewer          |        File Tree          |
|    accept/reject per hunk    |    git status decorations  |
+-------------------------------+---------------------------+
```

## Why Laborer?

Developers are spending $200+/month on AI coding agents (Claude Code, OpenCode, Codex) but can only effectively use **one at a time**. The bottleneck is no longer the AI -- it's the developer's ability to manage multiple agents at once.

- **No multi-agent visibility** -- Existing tools show one agent at a time. Laborer shows all of them simultaneously in split panes with real-time status tracking.
- **Manual environment management** -- Laborer automates git worktree creation, port allocation, dev server isolation, and file watcher scoping per workspace. Each agent gets a fully isolated environment automatically.
- **Disconnected workflows** -- Brings workspace execution and GitHub pull requests into one interface.
- **Wasted local compute** -- High-end dev machines sit idle while developers serialize work through a single agent. Laborer saturates your machine with parallel execution.

## Features

### Workspace Management
- **Git worktree-based workspaces** -- Each workspace gets its own branch, directory, and allocated port (range 3100-3999). Automatic setup scripts, port allocation, and full lifecycle management (create/run/stop/destroy). Auto-detects existing worktrees.

### Terminal and Agent Orchestration
- **Tmux-style panel layout** -- Recursive horizontal/vertical splits with keyboard shortcuts (Ctrl+B prefix), drag-and-drop workspace tabs, fullscreen mode, and tabbed window layout (window tabs > workspace tiles > panel tabs > panel splits).
- **Full terminal emulation** -- Real PTY terminals via node-pty + xterm.js with VS Code-grade flow control, 100k+ line scrollback, per-terminal MessagePort channels for zero-copy data transfer, and crash-resilient session persistence. Multiple terminals per workspace (agent, type checker, test runner, dev server, shell).
- **Agent status tracking** -- Detects when AI agents are active vs waiting for input via process inspection, with OS-level desktop notifications on status transitions. Supports OpenCode, Claude Code, and Codex.
- **Multi-window support** -- Multiple Electron windows with persistent layout, window state across restarts, and drag-and-drop tab reordering.

### Diffs and GitHub
- **Live diff viewer** -- Real-time git diffs against the worktree's base SHA with per-hunk accept/reject annotations. Split and unified views. Reactive updates via filesystem watcher.
- **File tree with git status** -- Lazy per-directory file browser with git status decorations, right-click context menus, and reactive invalidation.
- **GitHub PR integration** -- Tracks PR state (open/closed/merged) per workspace with ahead/behind counts.

### Desktop Distribution
- **Auto-updates** -- GitHub Releases-based auto-update keeps the desktop app current.

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TanStack Router, Tailwind CSS v4, shadcn/ui, xterm.js, LiveStore (OPFS-backed SQLite) |
| Desktop | Electron 40, electron-builder, electron-updater |
| Backend | Effect TS, @effect/rpc, node-pty, @parcel/watcher, LiveStore (better-sqlite3) |
| Tooling | Bun, Turborepo, Biome (Ultracite), Vitest, Playwright |

## Getting Started

Run these commands from the `current/` directory.

Install dependencies:

```bash
bun install
```

Start all services in development mode:

```bash
bun run dev
```

Start only the web app and backend services (no Electron):

```bash
bun run dev:web
```

## Architecture

Laborer runs as multiple cooperating services:

| Service | Default Port | Description |
|---|---|---|
| Web App | 2101 | React frontend (Vite dev server) |
| Terminal | 2102 | PTY terminal management and WebSocket I/O |
| File Watcher | 2104 | Filesystem watching via @parcel/watcher |
| Desktop | — | Electron shell (spawns backend services as sidecars in production) |

In development, Turborepo runs all services as separate processes. In production, the Electron main process spawns backend services as sidecar child processes with health monitoring and automatic crash recovery.

## Project Structure

```
current/
├── apps/
│   ├── web/              # React frontend (Vite + TanStack Router)
│   └── desktop/          # Electron main process
├── packages/
│   ├── server/           # Main backend server (Effect TS)
│   ├── terminal/         # PTY terminal service (Effect TS)
│   ├── file-watcher/     # File watcher service
│   ├── shared/           # Shared types, schema, RPC contracts
│   ├── env/              # Environment variable validation
│   └── config/           # Shared TypeScript config
├── docs/                 # Historical PRDs and progress notes
└── scripts/              # Build and setup scripts
```

## Project Configuration

Each project managed by Laborer uses a `laborer.json` config file:

```json
{
  "setupScripts": ["bun install"],
  "agent": "opencode2"
}
```

Supported agents: `opencode2`, `claude`, and `codex`. Existing
`"agent": "opencode"` configuration is migrated to `opencode2` when read.

## Available Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start all services in development mode |
| `bun run dev:web` | Start web app + backend services (no Electron) |
| `bun run build` | Build all packages |
| `bun run typecheck` | TypeScript type checking across all packages |
| `bun run test` | Run all tests (single pass) |
| `bun run test:watch` | Run tests in watch mode |
| `bun run check` | Run typecheck + format fix + tests |
| `bun run format` | Check Biome formatting and linting |
| `bun run format:fix` | Auto-fix formatting and linting |
| `bun run dist:desktop:dmg` | Build macOS desktop DMG |

## Development Flow

We use [git-worktree-runner (gtr)](https://github.com/coderabbitai/git-worktree-runner) for parallel branch development. This allows you to work on multiple branches simultaneously without stashing or switching.

### First-Time Setup

```bash
# Install gtr globally (one-time)
git clone https://github.com/coderabbitai/git-worktree-runner.git ~/.gtr
cd ~/.gtr && ./install.sh

# Configure gtr for this repo (one-time per clone)
../.gtr-setup.sh
```

### Daily Workflow

**Starting a new branch:**

```bash
# Create a worktree for your branch
git gtr new izak/feature-name

# Open in Cursor
git gtr editor izak/feature-name

# Or start an AI coding agent
git gtr ai izak/feature-name
```

This automatically:
- Creates a new worktree with your branch
- Copies `current/.env.local` (via gtr config)
- Copies AI tool config directories (`.opencode/`, `.cursor/`, `.claude/`)
- Runs `bun install` for the current app

**Cleanup:**

```bash
# Remove worktree when done
git gtr rm izak/feature-name

# List all worktrees
git gtr list
```
