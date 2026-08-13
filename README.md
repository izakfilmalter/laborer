# Laborer

Laborer connects Slack work threads, local coding runtimes, and a desktop mission-control interface. This Bun and Turborepo monorepo contains the product's cooperating apps and shared packages.

## Repository layout

- [`apps/bot/`](./apps/bot/) — Slack bridge, local daemon, ACP runtime, registered Actions, and macOS companion.
- [`apps/desktop/`](./apps/desktop/) — Electron shell for mission control.
- [`apps/web/`](./apps/web/) — React mission-control interface, used in a browser or the desktop shell.
- [`packages/`](./packages/) — shared services, domain contracts, persistence, terminal support, and tooling.

The bot and mission-control apps retain distinct runtime responsibilities while sharing contracts and durable infrastructure where their behavior overlaps.

## Requirements

- Bun 1.3.5
- Node 24.11.1 for the bot runtime; Node 24 or newer for the task MCP
- macOS for Electron packaging and launchd integration

## Development

Run commands from the repository root:

```sh
bun install
cp .env.example .env.local
bun run dev
```

`dev` starts the web app, mission-control services, and Electron shell. To run the Vite interface by itself or the bot daemon in watch mode:

```sh
bun run --cwd apps/web dev
bun run dev:bot
```

The repository uses one ignored root `.env.local`. Fill only the credentials needed by the runtime you are starting; the mission-control defaults in the example are not secrets.

## Common commands

| Command | Purpose |
| --- | --- |
| `bun run build` | Build all workspaces |
| `bun run typecheck` | Typecheck all workspaces |
| `bun run test` | Run deterministic tests once |
| `bun run format` | Check Biome/Ultracite formatting and linting |
| `bun run format:fix` | Apply Biome/Ultracite fixes |
| `bun run check` | Format, typecheck, test, scan for Slack secrets, and run ACP compatibility gates |
| `bun run start:bot` | Start the Slack daemon |
| `bun run dist:desktop:dmg` | Build the macOS desktop DMG |

See the [bot README](./apps/bot/README.md) for Slack configuration and durability, and the [desktop README](./apps/desktop/README.md) for the mission-control architecture and setup.
