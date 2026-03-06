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

export TAURI_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\"}}"

exec bun x tauri dev
