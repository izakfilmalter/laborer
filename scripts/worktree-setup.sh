#!/bin/bash
# scripts/worktree-setup.sh
# Called by gtr post-create hook to set up a new worktree
#
# gtr handles:
#   - Copying .env.local (via gtr.copy.include)
#
# This script handles:
#   - Calculating and storing worktree index
#   - Deriving a stable worktree slug from branch name
#   - Copying AI tool config directories
#   - Running bun install

set -e

# Get the root worktree path (main repo)
ROOT_WORKTREE_PATH="$(git rev-parse --path-format=absolute --git-common-dir | sed 's|/.git$||')"

# Calculate worktree index (count existing worktrees, subtract 1 since main repo is #0)
WORKTREE_INDEX=$(($(git worktree list | wc -l | tr -d ' ') - 1))

# Store index for reference
echo "$WORKTREE_INDEX" > .worktree-index

# Get branch name and worktree slug
BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD)
WORKTREE_SLUG="$(bash "$ROOT_WORKTREE_PATH/scripts/worktree-slug.sh" "$BRANCH_NAME")"

echo "Setting up worktree #$WORKTREE_INDEX"
echo "  Branch: $BRANCH_NAME"
echo "  Slug:   $WORKTREE_SLUG"

# Copy AI tool config directories from root worktree
if [ -d "$ROOT_WORKTREE_PATH/.opencode" ]; then
    cp -r "$ROOT_WORKTREE_PATH/.opencode" .opencode
    echo "  Copied .opencode directory"
fi
if [ -d "$ROOT_WORKTREE_PATH/.cursor" ]; then
    cp -r "$ROOT_WORKTREE_PATH/.cursor" .cursor
    echo "  Copied .cursor directory"
fi
if [ -d "$ROOT_WORKTREE_PATH/.claude" ]; then
    cp -r "$ROOT_WORKTREE_PATH/.claude" .claude
    echo "  Copied .claude directory"
fi

# Run bun install
echo ""
echo "Running bun install..."
bun install

echo ""
echo "Worktree setup complete!"
echo ""
echo "To start development:"
echo "  bun run dev"
