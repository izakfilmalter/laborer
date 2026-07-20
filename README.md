# Laborer

This repository contains two independent application roots:

- [`current/`](./current/) — the existing Laborer Bun/Turborepo application.
- `next/` — reserved for the new application.

Each application owns its package manifest, lockfile, dependencies, and build
configuration. Run package-manager commands from the relevant application
directory so dependencies do not leak between the two apps.

The `next/` directory is intentionally empty until the new application is
initialized, so Git will begin tracking it when its first files are added.

## Existing application

```bash
cd current
bun install
bun run dev
```
