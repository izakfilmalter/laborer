#!/bin/bash
# scripts/worktree-slug.sh
# Derives a short, stable slug from a branch name for worktree identification.
#
# Examples:
#   izak/dev-367-worktree-upgrades -> dev-367
#   feature/add-new-ui             -> add-new-ui
#   my-branch                      -> my-branch

set -euo pipefail

BRANCH_NAME="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"

if [ -z "$BRANCH_NAME" ] || [ "$BRANCH_NAME" = "HEAD" ]; then
  BRANCH_NAME="$(basename "$(pwd)")"
fi

# Strip prefix before / (e.g. izak/dev-367-foo -> dev-367-foo)
BRANCH_SEGMENT="${BRANCH_NAME#*/}"
if [ -z "$BRANCH_SEGMENT" ]; then
  BRANCH_SEGMENT="$BRANCH_NAME"
fi

BRANCH_SEGMENT_LOWER="$(printf '%s' "$BRANCH_SEGMENT" | tr '[:upper:]' '[:lower:]')"

# If segment starts with a ticket key like dev-367, extract just that
if [[ "$BRANCH_SEGMENT_LOWER" =~ ^([a-z]+-[0-9]+) ]]; then
  echo "${BASH_REMATCH[1]}"
  exit 0
fi

# Otherwise sanitize the full segment
SANITIZED_SEGMENT="$(printf '%s' "$BRANCH_SEGMENT_LOWER" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

if [ -n "$SANITIZED_SEGMENT" ]; then
  echo "$SANITIZED_SEGMENT"
else
  echo "dev"
fi
