#!/bin/bash
# scripts/tauri-dev.sh
# Launches tauri dev with a dynamic devUrl derived from the VITE_PORT env var.
# This allows worktrees to run Tauri on different ports without editing tauri.conf.json.

set -e

# Source root .env.local if it exists (provides VITE_PORT in worktrees)
ROOT_ENV="$(git rev-parse --show-toplevel)/.env.local"
if [ -f "$ROOT_ENV" ]; then
    set -a
    source "$ROOT_ENV"
    set +a
fi

VITE_PORT="${VITE_PORT:-2101}"

# Ensure sidecar stub files exist so Tauri's build validation passes in dev mode.
# In dev, the actual services run separately via turbo dev — these are just empty placeholders.
SIDECARS_DIR="$(dirname "$0")/../src-tauri/sidecars"
TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
mkdir -p "$SIDECARS_DIR"
for name in laborer-server laborer-terminal laborer-mcp; do
    stub="$SIDECARS_DIR/${name}-${TARGET_TRIPLE}"
    [ -f "$stub" ] || touch "$stub"
done

export TAURI_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\"}}"

exec bun x tauri dev
