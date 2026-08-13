# macOS LaunchAgent developer preview

The packaged Laborer companion registers its daemon as the per-user
`com.laborer.daemon` LaunchAgent through `SMAppService` on macOS 13 or newer.
The companion observes that service; it never spawns or owns the daemon.

## Package, install, and run

Use the repository-pinned Node 24.11.1 on the target Mac, then run:

```sh
bun run companion:package:macos
open "release/macos-$(node -p 'process.arch')/Laborer.app"
```

This produces an architecture-specific application for the current Mac. Run
the same command on Apple Silicon and Intel to produce both developer-preview
artifacts. The application contains that architecture's pinned Node executable,
the Node-dependent Slack daemon, the Service Management helper, and the
LaunchAgent property list. Move the complete application before opening it;
Service Management binds registration to that bundle.

On first run, macOS may require approval in **System Settings › General › Login
Items**. The companion reports registering, approval required, denied,
unavailable, and installation-version-mismatch separately from daemon health.
Reopening an already registered application adopts the existing status
connection and does not start a second root owner.

The LaunchAgent has `RunAtLoad` and `KeepAlive` enabled. It starts immediately,
at login, and after an exit. `SIGTERM` still enters the daemon's existing scoped
graceful shutdown; launchd, rather than the companion, then applies the restart
policy. Quitting or crashing the companion does not signal the daemon.

## Launch environment and secrets

The service uses the launchd user bootstrap environment. Prepare the existing
`SLACK_APP_TOKEN`, bot-token variables, workspace registry, and `LABORER_ROOT`
there before registration. `LABORER_ROOT` selects the default Laborer root and
prevents the packaged daemon from trying to read configuration from its
read-only application bundle. Runtime state is stored below
`$XDG_STATE_HOME/laborer`, or `~/.local/state/laborer` when `XDG_STATE_HOME` is
not an absolute nonblank path. Credential values must continue to be resolved
from Keychain directly into that environment; they are never written to the
property list, passed as daemon arguments, or sent to the companion. The
packaged app does not copy `.env.local`.

The LaunchAgent invokes only the fixed bundled `laborer-daemon` executable. Its
launcher adds `NODE_ENV=production` and otherwise preserves launchd's daemon
environment. The companion launches the native Service Management helper with
an empty environment, so Slack credentials cannot cross into helper arguments,
output, logs, or the renderer.

## Compatibility and uninstall

The companion accepts only the exact bundled daemon application version and
operator protocol version. The native helper also returns an exact helper
protocol and service-executable version. Any unsupported upgrade, rollback, or
mixed bundle fails closed and does not register or claim daemon health.

To cleanly unregister before deleting the developer-preview app:

```sh
"release/macos-$(node -p 'process.arch')/Laborer.app/Contents/Resources/service-management" unregister
```

## Opt-in acceptance

The acceptance changes the real per-user launchd domain and may open System
Settings for approval, so it is never part of offline CI:

```sh
LABORER_MACOS_ACCEPTANCE=1 bun run companion:acceptance:macos
```

It packages and registers the service, verifies launchd ownership, force-quits
and reopens the companion while preserving one daemon, exercises the login
restart policy with daemon `SIGTERM`, and unregisters cleanly. A first-run
approval result exits with instructions; approve it and rerun.
