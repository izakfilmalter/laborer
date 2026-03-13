#!/usr/bin/env bash
# Build GhosttyKit.xcframework from the vendored Ghostty submodule.
# Caches builds by ghostty commit SHA to avoid redundant rebuilds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
GHOSTTY_DIR="$REPO_ROOT/vendor/ghostty"

# --- Validate prerequisites ---

if ! command -v zig &>/dev/null; then
  echo "error: zig is required to build GhosttyKit."
  echo "Install it with: brew install zig"
  exit 1
fi

if [ ! -d "$GHOSTTY_DIR/.git" ] && [ ! -f "$GHOSTTY_DIR/.git" ]; then
  echo "Initializing ghostty submodule..."
  git -C "$REPO_ROOT" submodule update --init --recursive vendor/ghostty
fi

# The manaflow-ai/ghostty fork creates xcframework-* tags for CI prebuilt
# downloads. Ghostty's build system uses `git describe --tags` and panics
# when it finds a tag that doesn't match vX.Y.Z format. Remove these tags
# locally so the build falls through to the correct version logic.
xcframework_tags=$(git -C "$GHOSTTY_DIR" tag -l 'xcframework-*' 2>/dev/null || true)
if [ -n "$xcframework_tags" ]; then
  echo "Removing local xcframework-* tags to avoid Ghostty build conflict..."
  echo "$xcframework_tags" | xargs git -C "$GHOSTTY_DIR" tag -d >/dev/null 2>&1 || true
fi

# --- Derive cache key from ghostty submodule SHA ---

GHOSTTY_SHA="$(git -C "$GHOSTTY_DIR" rev-parse HEAD)"
CACHE_ROOT="${LABORER_GHOSTTYKIT_CACHE_DIR:-$HOME/.cache/laborer/ghosttykit}"
CACHE_DIR="$CACHE_ROOT/$GHOSTTY_SHA"
CACHED_XCFRAMEWORK="$CACHE_DIR/GhosttyKit.xcframework"
LOCAL_XCFRAMEWORK="$GHOSTTY_DIR/macos/GhosttyKit.xcframework"
OUTPUT_LINK="$PACKAGE_DIR/GhosttyKit.xcframework"

echo "Ghostty SHA: $GHOSTTY_SHA"

# --- Directory-based lock to prevent concurrent builds ---

LOCK_DIR="$CACHE_ROOT/${GHOSTTY_SHA}.lock"
LOCK_TIMEOUT=300

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      echo "warning: stale lock detected, removing $LOCK_DIR"
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR"
      return
    fi
    echo "Waiting for concurrent build to finish..."
    sleep 5
    waited=$((waited + 5))
  done
}

release_lock() {
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

mkdir -p "$CACHE_ROOT"
acquire_lock
trap release_lock EXIT

# --- Build or reuse cached xcframework ---

if [ -d "$CACHED_XCFRAMEWORK" ]; then
  echo "Cache hit: reusing GhosttyKit.xcframework for $GHOSTTY_SHA"
else
  # Check if a valid local build already exists
  if [ -d "$LOCAL_XCFRAMEWORK" ] && [ -f "$LOCAL_XCFRAMEWORK/.ghostty_sha" ]; then
    LOCAL_SHA="$(cat "$LOCAL_XCFRAMEWORK/.ghostty_sha")"
    if [ "$LOCAL_SHA" = "$GHOSTTY_SHA" ]; then
      echo "Local build matches current SHA, seeding cache..."
      mkdir -p "$CACHE_DIR"
      cp -R "$LOCAL_XCFRAMEWORK" "$CACHED_XCFRAMEWORK"
    fi
  fi

  if [ ! -d "$CACHED_XCFRAMEWORK" ]; then
    echo "Building GhosttyKit.xcframework from source..."
    echo "This may take several minutes on first build."
    (cd "$GHOSTTY_DIR" && zig build -Demit-xcframework=true -Demit-macos-app=false -Dxcframework-target=universal -Doptimize=ReleaseFast)

    if [ ! -d "$LOCAL_XCFRAMEWORK" ]; then
      echo "error: zig build did not produce GhosttyKit.xcframework"
      exit 1
    fi

    # Stamp the build with the ghostty SHA
    echo "$GHOSTTY_SHA" > "$LOCAL_XCFRAMEWORK/.ghostty_sha"

    # Atomically populate the cache
    CACHE_TMP="$CACHE_DIR.tmp.$$"
    mkdir -p "$CACHE_TMP"
    cp -R "$LOCAL_XCFRAMEWORK" "$CACHE_TMP/GhosttyKit.xcframework"
    mkdir -p "$CACHE_DIR"
    mv "$CACHE_TMP/GhosttyKit.xcframework" "$CACHED_XCFRAMEWORK"
    rm -rf "$CACHE_TMP"

    echo "Build complete and cached."
  fi
fi

# --- Create symlink in the package directory ---

rm -f "$OUTPUT_LINK"
ln -s "$CACHED_XCFRAMEWORK" "$OUTPUT_LINK"
echo "Symlinked GhosttyKit.xcframework -> $CACHED_XCFRAMEWORK"
echo "Setup complete."
