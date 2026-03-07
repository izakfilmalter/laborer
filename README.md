# laborer

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **shadcn/ui** - Reusable UI components
- **Biome** - Linting and formatting
- **Tauri** - Build native desktop applications
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.

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

# Or start Claude Code
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

## Git Hooks and Formatting

- Format and lint check: `bun run format`
- Format and lint fix: `bun run format:fix`

## Project Structure

```
laborer/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run typecheck`: Check TypeScript types across all apps
- `bun run format`: Check Biome formatting and linting
- `bun run format:fix`: Fix Biome formatting and linting
- `bun run test`: Run tests across all packages (single pass)
- `bun run test:watch`: Run tests in watch mode
- `bun run check`: Run typecheck, format fix, and tests via single turbo invocation
- `cd apps/web && bun run desktop:dev`: Start Tauri desktop app in development
- `cd apps/web && bun run desktop:build`: Build Tauri desktop app
