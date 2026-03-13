# Laborer

A local-first desktop application for orchestrating multiple AI coding agents in parallel. Laborer provides a tmux-style panel system where each pane is a live terminal running an AI agent, a diff viewer, or a raw shell — enabling you to monitor and interact with many agents working on different branches simultaneously.

## Why Laborer?

Running 4-10+ AI coding agents at once is painful without purpose-built tooling:

- **No multi-agent visibility** — Existing tools show one agent at a time. Laborer shows all of them simultaneously in split panes.
- **Manual environment management** — Laborer automates git worktree creation, port allocation, dev server isolation, and file watcher scoping per workspace.
- **Disconnected workflows** — Unifies the pipeline from PRD writing to issue creation to implementation to review in a single interface.

## Features

- **Tmux-style panel layout** — Recursive horizontal/vertical splits with keyboard shortcuts, drag-and-drop workspace tabs, and fullscreen mode
- **Git worktree-based workspaces** — Each workspace gets its own branch, directory, and allocated port. Automatic setup scripts, port allocation, and full lifecycle management
- **Full terminal emulation** — Real PTY terminals via node-pty + xterm.js with WebSocket streaming. Multiple terminals per workspace (agent, type checker, test runner, dev server, shell)
- **Live diff viewer** — Real-time git diffs against the worktree's base SHA with accept/reject annotations
- **Agent status tracking** — Detects when AI agents are active vs waiting for input, with OS-level notifications
- **PRD editor** — Rich text editor for writing product requirements documents, with issue creation directly from PRDs
- **Task management** — Import tasks from GitHub Issues, Linear tickets, or create manually. Create workspaces directly from tasks
- **Docker container support** — Optional containerized dev servers via OrbStack with bind-mounted worktrees
- **GitHub PR integration** — Tracks PR state (open/closed/merged) per workspace
- **MCP server** — Model Context Protocol server for PRD and issue management, enabling AI agents to interact with Laborer
- **Multi-window support** — Multiple Electron windows with persistent layout and window state
- **Auto-updates** — GitHub Releases-based auto-update for the desktop app

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TanStack Router, Tailwind CSS v4, shadcn/ui, xterm.js, Platejs, LiveStore (OPFS-backed SQLite) |
| Desktop | Electron 40, electron-builder, electron-updater |
| Backend | Effect TS, @effect/rpc, node-pty, @parcel/watcher, LiveStore (better-sqlite3) |
| Tooling | Bun, Turborepo, Biome (Ultracite), Vitest, Playwright |

## Getting Started

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
| Server | 2100 | Main backend — workspaces, projects, tasks, PRDs, diffs, containers |
| Web App | 2101 | React frontend (Vite dev server) |
| Terminal | 2102 | PTY terminal management and WebSocket I/O |
| File Watcher | 2104 | Filesystem watching via @parcel/watcher |
| MCP | stdio | MCP server for AI agent tool integration |
| Desktop | — | Electron shell (spawns backend services as sidecars in production) |

In development, Turborepo runs all services as separate processes. In production, the Electron main process spawns backend services as sidecar child processes with health monitoring and automatic crash recovery.

## Project Structure

```
laborer/
├── apps/
│   ├── web/              # React frontend (Vite + TanStack Router)
│   └── desktop/          # Electron main process
├── packages/
│   ├── server/           # Main backend server (Effect TS)
│   ├── terminal/         # PTY terminal service (Effect TS)
│   ├── file-watcher/     # File watcher service
│   ├── mcp/              # MCP server for AI agent integration
│   ├── shared/           # Shared types, schema, RPC contracts
│   ├── env/              # Environment variable validation
│   └── config/           # Shared TypeScript config
├── docs/                 # PRDs and progress notes
└── scripts/              # Build and setup scripts
```

## Project Configuration

Each project managed by Laborer uses a `laborer.json` config file:

```json
{
  "devServer": {
    "startCommand": "bun dev",
    "image": "node:22",
    "autoOpen": true
  },
  "setupScripts": ["bun install"],
  "agent": "opencode"
}
```

Supported agents: `opencode`, `claude`, `codex`, `rlph`.

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
./.gtr-setup.sh
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
- Copies `.env.local` (via gtr config)
- Copies AI tool config directories (`.opencode/`, `.cursor/`, `.claude/`)
- Runs `bun install`

**Cleanup:**

```bash
# Remove worktree when done
git gtr rm izak/feature-name

# List all worktrees
git gtr list
```
