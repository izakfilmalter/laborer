## Problem Statement

When running multiple AI coding agents in parallel, each workspace needs its own dev server to preview changes. Running 4-10+ instances of the same application's dev server on the host OS creates compounding problems:

1. **File watcher exhaustion**: Dev server tooling (Vite, Webpack, Next.js) uses file watchers that consume memory and CPU per watched file. Running multiple copies means multiplicative watcher overhead. When limits are hit, frameworks fall back to polling, which breaks hot module replacement (HMR) and hot reload -- the core feedback loop for verifying agent changes.

2. **Port conflicts**: Each dev server needs a unique port. Laborer currently allocates ports from a 2200-2999 range, but users must remember which port maps to which workspace. Port numbers are not human-friendly, and stale browser tabs can show the wrong workspace's content when ports are reused.

3. **No stable URLs**: There is no way to bookmark or share a workspace's dev server. The port number changes across workspace restarts. AI agents also struggle with dynamic port assignments when they need to test their own changes.

These problems scale linearly with the number of concurrent workspaces and make Laborer's core value proposition -- running many agents in parallel -- increasingly painful as usage grows.

## Solution

Run each workspace's dev server inside a Docker container managed by OrbStack. OrbStack provides lightweight Linux containers on macOS with automatic `.orb.local` domain names, eliminating both the file watcher and port problems simultaneously.

When a workspace is created, Laborer:
1. Creates the git worktree (existing behavior)
2. Starts a Docker container with the worktree bind-mounted into it
3. Opens a dedicated "dev server" terminal pane with a shell session inside the container
4. Auto-runs any configured setup scripts (e.g. `bun install`)
5. Auto-types the configured dev server start command (e.g. `bun dev`) and executes it

The dev server runs inside the container's Linux environment with its own isolated `inotify` file watchers. OrbStack automatically assigns the container a domain like `feature-auth--myproject.orb.local`, which is displayed as a clickable link in the workspace UI where the port number currently appears.

The AI agent's terminal continues to run on the host (in the worktree directory). Code changes flow bidirectionally via VirtioFS bind mounts -- the agent writes files on the host, and the containerized dev server's file watchers pick them up immediately.

## User Stories

1. As a developer using Laborer, I want each workspace's dev server to run in an isolated container, so that file watcher limits on my host OS don't cause HMR to degrade or fall back to polling when I run many workspaces.

2. As a developer, I want each workspace to have a stable, human-readable URL like `feature-auth--myproject.orb.local`, so that I can bookmark it, share it, and know which workspace I'm looking at in my browser.

3. As a developer, I want the dev server container to start automatically when I create a workspace, so that I don't have to manually set up the container environment each time.

4. As a developer, I want to see a clickable `.orb.local` link in the workspace UI (replacing the current port number display), so that I can quickly open the dev server in my browser.

5. As a developer, I want a copy button next to the `.orb.local` URL (matching the existing worktree name copy button pattern), so that I can easily paste the URL into other tools or share it.

6. As a developer, I want setup scripts (like `bun install`) to run automatically inside the container before the dev server starts, so that the workspace is ready to use without manual intervention.

7. As a developer, I want the dev server start command to be auto-typed into a terminal pane inside the container, so that I can see the boot logs, interact with the process (Ctrl+C), and re-run it if needed.

8. As a developer, I want the dev server terminal pane to be toggleable (like the diff viewer), so that I can show or hide it based on whether I need to see the logs right now.

9. As a developer, I want the dev server terminal pane to be visually distinct from agent terminal panes, so that I can immediately tell which pane is the dev server versus which is an AI agent.

10. As a developer, I want the play/pause buttons in the workspace sidebar to pause/unpause the Docker container (freezing the process tree), so that I can temporarily free CPU resources without losing the dev server's running state.

11. As a developer, I want resuming a paused workspace to instantly restore the dev server (via Docker unpause), so that I don't have to wait for setup scripts and the dev server to restart from scratch.

12. As a developer, I want to configure the container image in `laborer.json` (either a Dockerfile path or a base image name), so that I can customize the dev server environment to match my project's needs.

13. As a developer, I want to configure the dev server start command in `laborer.json` as a project setting, so that it is consistent across all workspaces for that project.

14. As a developer, I want the AI agent terminal to remain on the host (not inside the container), so that the agent has full access to host tools like git, the Laborer MCP server, and my editor.

15. As a developer, I want changes made by the AI agent on the host to be immediately visible to the dev server inside the container (via bind mounts), so that HMR works seamlessly across the host-container boundary.

16. As a developer, I want Laborer to detect whether OrbStack/Docker is available on my system and show a clear error if it's not installed, so that I know what prerequisite I need to set up.

17. As a developer, I want the container to be destroyed when the workspace is destroyed (worktree removed), so that I don't accumulate orphaned containers.

18. As a developer, I want `laborer.json` to support specifying either a Dockerfile path or a base image name for the container, so that simple projects can just reference `node:22` while complex projects can define custom Dockerfiles.

19. As a developer, I want the `.orb.local` URL to work with HTTPS automatically (OrbStack provides this), so that I can test HTTPS-dependent features locally.

20. As a developer, I want the container naming to follow a predictable `branch--project` pattern, so that I can predict the URL for a workspace before it's created.

## 'Polishing' Requirements

1. Verify that HMR/hot reload works reliably across the bind mount boundary for popular frameworks (Vite, Next.js, Remix, Astro) with large file trees (10k+ files).

2. Ensure the `.orb.local` link in the UI uses the same visual treatment (typography, hover state, copy button) as the existing worktree name display for consistency.

3. Confirm that the dev server terminal pane's show/hide toggle has the same interaction pattern as the diff viewer toggle (keyboard shortcut, button placement, animation).

4. Verify that pausing and unpausing containers is fast enough (<1 second) to feel instantaneous in the UI.

5. Ensure error states are handled gracefully: Docker/OrbStack not running, container crash, port already in use inside container, setup script failure, network unreachable.

6. Verify that the container naming sanitization handles edge cases: branches with slashes (`feature/auth`), very long branch names (DNS label limit of 63 chars), special characters, and duplicate names.

7. Confirm that the play/pause workspace controls correctly reflect the container state (not just the Laborer-internal state) -- i.e., if a container crashes, the UI should show it as stopped.

8. Ensure that destroying a workspace fully cleans up: kills the container terminal session, stops the container, removes the container, removes the worktree.

9. Verify that the dev server terminal pane correctly reconnects if the user navigates away and comes back (matching existing terminal reconnection behavior).

10. Confirm that the setup scripts run to completion before the dev server command is typed, with clear error reporting if a setup script fails.

## Implementation Decisions

### Container Runtime

- **OrbStack (Docker)** is the v1 runtime. Users must have OrbStack installed. The existing `WorkspaceProvider` Effect service interface will be extended to include container lifecycle methods alongside the existing worktree methods.
- Docker CLI commands (`docker run`, `docker pause`, `docker unpause`, `docker stop`, `docker rm`) will be used for container management via the Bun child process API.
- The architecture is designed so that a future `AppleContainerProvider` or `DaytonaProvider` could replace the Docker layer.

### Container Configuration in `laborer.json`

A new `devServer` section will be added to the `laborer.json` schema:

```json
{
  "devServer": {
    "image": "node:22",
    "dockerfile": "./Dockerfile.dev",
    "startCommand": "bun dev",
    "workdir": "/app"
  }
}
```

- `image` and `dockerfile` are mutually exclusive. If `dockerfile` is provided, Laborer builds the image. If `image` is provided, it pulls it directly.
- `startCommand` is the command auto-typed into the dev server terminal.
- `workdir` is the mount point inside the container (defaults to `/app`).
- The existing `setupScripts` array continues to work -- these scripts run inside the container before the start command.

### Container Naming and URLs

- Containers are named `{branchSlug}--{projectName}` producing URLs like `feature-auth--myproject.orb.local`.
- Branch names are sanitized: slashes become hyphens, truncated to 63 chars with a hash suffix if needed (matching Portless's approach).
- OrbStack automatically provides HTTPS at `https://feature-auth--myproject.orb.local`.

### Dev Server Terminal Pane

- A new pane type `devServerTerminal` is added alongside the existing `terminal` and `diff` pane types.
- The pane spawns a terminal session via `docker exec -it {containerName} /bin/sh` (or `/bin/bash` if available).
- Setup scripts are executed sequentially in this terminal before the start command is auto-typed.
- The pane is toggleable via a button in the workspace header, matching the diff viewer toggle pattern.
- The pane has a distinct visual indicator (e.g., a colored border or icon) to differentiate it from agent terminals.

### Container Lifecycle

- **Create workspace** -> create worktree + start container (eager start).
- **Pause workspace** -> `docker pause` (freezes process tree, retains memory state).
- **Resume workspace** -> `docker unpause` (instant resume, no re-setup needed).
- **Destroy workspace** -> kill terminal session, `docker stop`, `docker rm`, remove worktree.
- The existing workspace state machine (`stopped` / `running`) maps to container state. The container is the source of truth for whether the workspace is "running."

### UI Changes

- The port number display in the workspace sidebar/card is replaced with the `.orb.local` URL as a clickable link.
- A copy-to-clipboard button appears on hover, matching the existing worktree name copy button pattern.
- The play/pause buttons control `docker pause`/`docker unpause`.
- A new toggle button for the dev server terminal pane appears alongside the existing diff viewer toggle.

### Docker Prerequisite Detection

- On startup, Laborer checks for `docker` CLI availability and OrbStack status.
- If Docker/OrbStack is not available, a clear onboarding message is shown with installation instructions.
- This check runs as part of the server startup health checks.

### Port Allocation Changes

- The existing `PortAllocator` service is no longer needed for dev server ports. Inside the container, the dev server always binds to a standard port (e.g., 3000). OrbStack handles the routing via the `.orb.local` domain.
- The `PortAllocator` may still be retained for non-containerized use cases or other services.

## Testing Decisions

Good tests for this feature should verify external behavior (container starts, URL resolves, terminal connects) rather than implementation details (Docker CLI arguments, internal state transitions).

### Modules to test

1. **Container naming/sanitization logic** -- Unit tests for branch name to container name conversion. Edge cases: slashes, long names, special characters, duplicates. This is a pure function and easy to test in isolation.

2. **Container lifecycle service** -- Integration tests that verify the full lifecycle: create -> start -> pause -> unpause -> stop -> remove. These tests require Docker/OrbStack to be available and should be tagged as integration tests.

3. **`laborer.json` devServer config parsing** -- Unit tests for the new schema fields, validation of mutually exclusive `image`/`dockerfile`, default values.

4. **Docker prerequisite detection** -- Unit tests with mocked CLI responses for Docker available, Docker not installed, OrbStack not running.

### Prior art

The existing `WorkspaceProvider` tests and `ConfigService` tests in the server package provide the pattern for these tests. The terminal service tests show how to test terminal lifecycle without a real PTY.

## Out of Scope

- **Apple Containers / `apple/container` support**: The `WorkspaceProvider` interface accommodates future providers, but only Docker/OrbStack is implemented in v1.
- **Container resource limits (CPU/memory)**: No resource capping in v1. Containers use whatever resources they need.
- **Container health checks**: No automated health checking of the dev server. The user can see the terminal output to diagnose issues.
- **Volume persistence between container recreations**: When a container is destroyed and recreated (not pause/unpause), `node_modules` and other generated files inside the container are lost. The bind-mounted worktree persists because it lives on the host.
- **Multi-service containers (Docker Compose)**: V1 supports a single container per workspace. Projects needing databases or other services should handle those separately.
- **Remote/cloud containers**: Containers run locally on the developer's Mac only.
- **Windows/Linux host support**: OrbStack is macOS-only. Laborer is macOS-only.
- **Custom networking**: No custom Docker networks. Containers use OrbStack's default network.
- **Portless integration**: OrbStack's `.orb.local` domains replace the need for Portless entirely.
- **Automatic dev server restart on crash**: If the dev server crashes, the user manually restarts it in the terminal pane.

## Further Notes

- The bind mount approach means that `node_modules` installed inside the container are visible on the host (and vice versa). This is generally fine for interpreted languages (Node.js, Python) but could cause issues with native modules compiled for Linux vs macOS. Projects with native dependencies should use a Dockerfile that installs dependencies at build time (not in the bind-mounted directory). This is a known trade-off documented in the project setup guide.

- OrbStack's VirtioFS implementation is highly optimized for macOS and handles file change notifications well. However, very large monorepos (100k+ files) may still see some latency on initial file tree scanning. This is a known OrbStack characteristic, not a Laborer issue.

- The `docker exec` approach for the dev server terminal means the terminal session runs as a process inside the container. If the container is paused, the terminal session is also frozen. When unpaused, the terminal resumes. This is the expected behavior.

- Container images should be pre-pulled or cached to avoid slow first-run experiences. Laborer could optionally pre-pull the configured image when a project is first added, but this is a polish item, not a v1 requirement.
