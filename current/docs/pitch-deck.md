# Laborer -- Pitch Deck

---

## The Problem

Developers are spending $200+/month on AI coding agents (Claude Code, OpenCode, Codex) but can only use **one at a time**.

Running multiple agents in parallel today means:

- **No visibility** -- Existing tools show one agent at a time. Developers alt-tab between 4-10 terminal windows with no unified view.
- **Manual environment management** -- Each agent needs its own git branch, working directory, port allocation, dev server, and file watcher. Setting this up by hand for every task is slow and error-prone.
- **Disconnected workflows** -- Planning happens in Linear, coding in the terminal, review in GitHub, fixes back in the terminal. Constant context-switching kills throughput.
- **Wasted local compute** -- High-end dev machines sit idle while developers serialize work through a single agent.

**The bottleneck is no longer the AI. It's the developer's ability to manage multiple AI agents at once.**

---

## The Solution

**Laborer is mission control for parallel AI coding agents.**

A local-first desktop app that lets developers orchestrate 4-10+ AI agents simultaneously -- each in an isolated workspace with its own branch, directory, and dev server -- all visible in a single tmux-style interface.

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

---

## How It Works

### 1. Add a project
Point Laborer at any git repository. It auto-detects existing worktrees and configures the agent runner.

### 2. Create workspaces
Each workspace spins up an isolated environment:
- Dedicated **git worktree** (own branch and directory)
- Allocated **dev server port** (range 3100-3999)
- Optional **Docker container** via OrbStack for full isolation
- Automatic **setup scripts** (install dependencies, start dev server)

### 3. Launch agents

### 4. Monitor everything

### 5. Review and ship

---

## Key Features

| Feature | What It Does |
|---|---|
| **Tmux-style panel system** | Recursive splits, keyboard shortcuts, drag-and-drop, fullscreen mode. Everything a power user expects. |
| **Automated workspace isolation** | Git worktrees, port allocation, dev servers, file watchers -- all managed automatically per agent. |
| **Full terminal emulation** | Real PTY terminals (node-pty + xterm.js) with VS Code-grade flow control, 100k+ scrollback, and crash-resilient session persistence. |
| **Live diff viewer** | Real-time git diffs with per-hunk accept/reject. Split and unified views. Reactive updates via filesystem watcher. |
| **File tree with git status** | Lazy-loaded directory tree with git status decorations and context menus. |
| **Agent status tracking** | Detects active vs. waiting agents. Desktop notifications when an agent needs input. |
| **Docker container support** | OrbStack-backed containers with bind-mounted worktrees and stable `.orb.local` URLs. |
| **Multi-window support** | Multiple windows with persistent layout, tabbed workspaces, and drag-and-drop reordering. |
| **Auto-updates** | Ship new versions via GitHub Releases. Users stay current automatically. |

---

## Architecture

Laborer is built for reliability and performance, mirroring battle-tested patterns from VS Code:

```
+----------------------------------------------------------+
|                    Electron Main Process                  |
|  Window lifecycle, global shortcuts, service orchestration|
+----------+----------+----------+----------+--------------+
           |          |          |          |
    [Utility Process] [Utility Process] [Utility Process]
     Server :2100      Terminal :2102   File Watcher :2104
     - Workspaces      - PTY mgmt      - @parcel/watcher
     - Git ops         - WebSocket IO  - Reactive streams
     - Diffs           - Ring buffer
     - Containers      - Flow control
+----------------------------------------------------------+
|                    React 19 Renderer                      |
|  TanStack Router, LiveStore (OPFS SQLite), xterm.js      |
|  shadcn/ui, Tailwind CSS v4, @pierre/diffs & trees       |
+----------------------------------------------------------+
```

**Key architectural decisions:**

- **Process isolation** -- Each backend service runs in its own Electron Utility Process. A terminal crash doesn't take down the server. Automatic restart with exponential backoff.
- **LiveStore sync** -- Event-sourced SQLite state with bidirectional sync between server and client. Offline-capable. Instant UI updates.
- **Effect TS throughout** -- Type-safe services, RPC, error handling, and dependency injection via Effect layers. No runtime surprises.
- **MessagePort IPC** -- Binary-efficient structured clone between processes. Per-terminal dedicated channels for zero-copy data transfer.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Desktop** | Electron 40, electron-builder, auto-updates |
| **Frontend** | React 19, TanStack Router, Tailwind v4, shadcn/ui, xterm.js, Plate.js |
| **Backend** | Effect TS v3, @effect/rpc, node-pty, @parcel/watcher |
| **State** | LiveStore (SQLite event sourcing, bidirectional sync) |
| **Tooling** | Bun, Turborepo, Biome (Ultracite), Vitest, Playwright |

100% TypeScript. No Python. No Rust. One language across the entire stack.

---

## Competitive Landscape

|  | Laborer | tmux + terminals | Mux | t3code |
|---|---|---|---|---|
| Multi-agent visibility | All agents in split panes simultaneously | Manual window management | Isolated agent windows | Single agent view |
| Workspace isolation | Automated (worktrees, ports, containers) | Manual setup per session | Automated (containers) | Manual |
| Diff viewer | Built-in, per-hunk accept/reject | External tool | None | None |
| Process isolation | VS Code-grade utility processes | N/A | Container-based | Single process |
| Desktop app | Native Electron | Terminal-only | Electron | Electron |

**Laborer is the only tool purpose-built for developers who run multiple AI agents in parallel.**

---

## Market Opportunity

The AI coding agent market is exploding:

- **Anthropic** launched Claude Code (Max plan: $200/month, unlimited usage)
- **OpenAI** launched Codex (Pro plan: $200/month)
- **Google** launched Jules (agent for Gemini)
- **Open source** agents (OpenCode, Aider, Continue) growing rapidly

Developers with unlimited AI subscriptions have **no tooling to fully leverage their investment**. They're paying for parallel capacity but forced into serial workflows.

**Every developer running AI agents is a potential Laborer user.** The question isn't whether they need multi-agent orchestration -- it's when.

---

## Design Philosophy

1. **Terminals are the primitive.** Everything is a terminal. An agent is a terminal running opencode. A test runner is a terminal running vitest. The UI provides chrome around terminals, never replaces them.

2. **Local-first, API-first.** Everything runs on the developer's machine. No cloud dependency. The API is the primary interface; the UI is a client. Future integrations (Slack bots, CLI, CI) are architectural no-ops.


4. **Keyboard-first.** Tmux-style shortcuts (Ctrl+B prefix), vim-inspired navigation, zero mouse dependency for power users.

---

## Current State

**Late alpha / early beta.** Core features are implemented and working:

- 886 commits, 65+ issues completed, 28 PRDs written
- Daily-driven by the author for real development work
- macOS primary, cross-platform architecture

### Roadmap

| Next | Description |
|---|---|
| **Ghostty terminal** | Replace xterm.js with Metal-accelerated native terminal rendering |
| **E2E test suite** | Playwright coverage for full user flows |
| **Browser standalone** | Web app usable without Electron for remote/lightweight access |
| **Enhanced repo watching** | OpenCode-inspired git monitoring and reactive workspace updates |
| **Service lifecycle v2** | Phased startup/shutdown for faster launch times |

---

## The Ask

Laborer solves the infrastructure gap between "I have unlimited AI agent access" and "I can actually use it." Every developer running multiple AI agents needs a command center. Laborer is that command center.

---

*Laborer -- Mission control for parallel AI coding agents.*
