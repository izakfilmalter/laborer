# Legacy app workspaces run on local worktrees only

The Legacy Laborer app grew a sandbox execution layer — a provider abstraction with a Docker/OrbStack implementation and a Daytona cloud implementation (remote worktrees, SSH config management, terminal-ID-prefix routing, snapshot caching) — so dev servers and agent terminals could run inside containers or cloud sandboxes. With the Slack-native Laborer superseding the legacy app, we decided to remove the sandbox layer entirely: every workspace is a plain local git worktree, and terminals always spawn locally.

## Considered Options

- **Keep Docker-only, drop Daytona** — rejected: keeps the container lifecycle, image cache, and column plumbing alive for a workflow nobody uses.
- **Keep the provider abstraction dormant** — rejected: an interface with zero implementations is dead surface that every workspace and terminal change must still thread through.
- **Full removal** — chosen.

## Consequences

- The container/sandbox LiveStore events (six `v1.Container*`, seven `v2.Sandbox*`) are frozen forever as no-op decoders per event-log immutability; the sandbox columns are dropped from the workspaces table, and `workspaceCreated`'s optional provider field remains decode-only.
- Historical cloud-backed workspaces (empty local worktree path) are treated as stale and destroyed by worktree reconciliation, not preserved.
- User-side artifacts are orphaned by design: Docker containers and cached dependency images, Daytona cloud sandboxes and snapshots (which bill until manually deleted), and laborer-managed SSH config entries. Cleanup is a manual operator step, not code.
- Electron/Chromium renderer sandboxing is unrelated to this decision and stays.
