#!/bin/bash
# .gtr-setup.sh
# One-time gtr configuration for this repo
# Run this once after cloning the repo

set -e

# Get repo directory name dynamically
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"

echo "Configuring gtr for $REPO_NAME..."

# Worktree directory (sibling to repo, named <repo>.worktrees)
git gtr config set gtr.worktrees.dir "../${REPO_NAME}.worktrees"

# Create the worktrees directory if it doesn't exist and add biome.json
# that extends from the main repo's config (needed for VS Code multi-root workspaces)
WORKTREES_DIR="../${REPO_NAME}.worktrees"
if [ ! -d "$WORKTREES_DIR" ]; then
    mkdir -p "$WORKTREES_DIR"
fi
if [ ! -f "$WORKTREES_DIR/biome.json" ]; then
    cat > "$WORKTREES_DIR/biome.json" << EOF
{
  "\$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "extends": ["../${REPO_NAME}/biome.json"]
}
EOF
    echo "  Created biome.json in worktrees directory"
fi

# Default editor
git gtr config set gtr.editor.default cursor

# Default AI tool
git gtr config set gtr.ai.default claude

# Copy .env.local to worktrees (gtr handles copying, script handles overrides)
git gtr config add gtr.copy.include ".env.local"

# Post-create hook for worktree setup and bun install
# Use absolute path since hook runs from within the new worktree
git gtr config add gtr.hook.postCreate "$REPO_ROOT/scripts/worktree-setup.sh"

echo ""
echo "gtr configured successfully!"
echo ""
echo "Usage:"
echo "  git gtr new <branch>     # Create a new worktree"
echo "  git gtr editor <branch>  # Open in Cursor"
echo "  git gtr ai <branch>      # Start Claude"
echo "  git gtr rm <branch>      # Remove worktree"
echo "  git gtr list             # List all worktrees"
