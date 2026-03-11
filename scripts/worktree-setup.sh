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
#   - Copying .reference directory
#   - Updating .env.local with worktree-specific ports
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

# Worktree-specific ports offset by index
# Base ports (worktree #0 / main): PORT=2100, Vite=2101, TERMINAL_PORT=2102
# Each worktree gets a 10-port stride to avoid collisions
STRIDE=$((WORKTREE_INDEX * 10))
SERVER_PORT=$((2100 + STRIDE))
VITE_PORT=$((2101 + STRIDE))
TERMINAL_PORT=$((2102 + STRIDE))
# Each worktree gets a dedicated 10-port workspace allocation range
PORT_RANGE_START=$((2200 + STRIDE))
PORT_RANGE_END=$((2209 + STRIDE))

echo "Setting up worktree #$WORKTREE_INDEX"
echo "  Branch:         $BRANCH_NAME"
echo "  Slug:           $WORKTREE_SLUG"
echo "  Server:         http://localhost:$SERVER_PORT"
echo "  Vite:           http://localhost:$VITE_PORT"
echo "  Terminal:       http://localhost:$TERMINAL_PORT"
echo "  Workspace range: $PORT_RANGE_START-$PORT_RANGE_END"

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

# Copy .reference from root worktree
if [ -d "$ROOT_WORKTREE_PATH/.reference" ] && [ ! -e ".reference" ]; then
    cp -r "$ROOT_WORKTREE_PATH/.reference" .reference
    echo "  Copied .reference directory"
fi

# Append worktree-specific config to .env.local
# Later values override earlier ones, so we just append at the bottom
if [ -f ".env.local" ]; then
    cat >> .env.local << EOF

# Worktree #$WORKTREE_INDEX overrides
WORKTREE_SLUG=$WORKTREE_SLUG
WORKTREE_INDEX=$WORKTREE_INDEX
PORT=$SERVER_PORT
TERMINAL_PORT=$TERMINAL_PORT
PORT_RANGE_START=$PORT_RANGE_START
PORT_RANGE_END=$PORT_RANGE_END
VITE_SERVER_URL=http://localhost:$SERVER_PORT
VITE_SERVER_PORT=$SERVER_PORT
VITE_TERMINAL_PORT=$TERMINAL_PORT
VITE_PORT=$VITE_PORT
EOF
    echo "  Appended worktree overrides to .env.local"
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
