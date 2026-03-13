# Ghostty Configuration in Laborer

## Overview

Ghostty terminals in Laborer use Ghostty's standard configuration files for fonts, themes, and keybindings. Laborer does not provide its own settings UI for Ghostty — configuration follows standard Ghostty conventions.

## Config File Location

Ghostty loads its configuration from the standard config file path on macOS:

```
~/.config/ghostty/config
```

This is the same file used by the standalone Ghostty terminal application. Any settings you configure for Ghostty will also apply to Ghostty terminals inside Laborer.

## How Config Loading Works

1. When Laborer starts the Ghostty helper process, the Ghostty runtime loads configuration files automatically during app initialization.
2. The default config file (`~/.config/ghostty/config`) is loaded first.
3. If the config file contains `config-file` directives, those referenced files are loaded recursively.
4. Config is finalized and applied before any terminal surfaces are created.
5. Config changes take effect on **new terminal surfaces** — existing terminals are not reloaded.

## What Config Controls

Ghostty configuration affects:

- **Fonts**: font family, size, weight, and rendering options
- **Theme/Colors**: color scheme, background, foreground, cursor colors
- **Keybindings**: key mappings and shortcuts within the terminal
- **Terminal behavior**: scrollback size, cursor style, mouse behavior, etc.

For a full list of Ghostty configuration options, see the [Ghostty documentation](https://ghostty.org/docs/config).

## Config Diagnostics

If the config file contains parse errors or invalid settings, Laborer reports these as diagnostics:

- Config diagnostics are logged to the Ghostty helper process stderr (visible in Laborer's debug logs)
- A `config_loaded` event is emitted at startup with any diagnostics
- Invalid settings are skipped — Ghostty uses defaults for any unparseable options
- **Missing config files are not an error** — Ghostty works with its built-in defaults when no config file exists

## Troubleshooting

### Config file not being loaded

1. Verify the config file exists at `~/.config/ghostty/config`
2. Check file permissions (must be readable by the current user)
3. Look for config diagnostics in Laborer's debug logs

### Config changes not taking effect

- Config is loaded when the Ghostty helper process starts
- Close and reopen Ghostty terminals after changing config
- If the helper process is already running, restart Laborer or use the sidecar restart mechanism

### Viewing the config file path

The Ghostty Host process logs the config file path during startup. Check stderr output for:

```
[ghostty-host] Ghostty config path: /Users/<username>/.config/ghostty/config
```

## Limitations

- **No live reload**: Config changes require creating new terminal surfaces. Existing surfaces keep their original config.
- **No Laborer settings UI**: Ghostty config is managed by editing the config file directly, not through Laborer's UI.
- **No per-terminal config**: All Ghostty terminals in Laborer share the same config. Per-surface config overrides are not supported in the first version.
