/**
 * Maps worktree setup step keys to human-readable display labels.
 *
 * The step keys are stored in the `worktreeSetupStep` column of the
 * workspaces LiveStore table and emitted via `v1.WorktreeSetupStepChanged`
 * events during background workspace creation.
 *
 * Shared between the workspace card list and the empty terminal pane so
 * both surfaces show the same setup progress while a workspace is being
 * created.
 *
 * @see apps/web/src/lib/sandbox-setup-labels.ts — sandbox counterpart
 */

/**
 * Returns a human-readable label for a worktree setup step key.
 *
 * When `worktreeSetupStep` is non-null, the UI renders this label
 * alongside a spinner to indicate setup progress. When the step is
 * null, the progress indicator is cleared (setup complete).
 */
const getWorktreeSetupLabel = (step: string): string => {
  switch (step) {
    case 'fetching-remote':
      return 'Fetching latest remote refs...'
    case 'creating-worktree':
      return 'Creating git worktree...'
    case 'validating-worktree':
      return 'Validating worktree...'
    case 'running-setup-scripts':
      return 'Running setup scripts...'
    default:
      return 'Setting up workspace...'
  }
}

export { getWorktreeSetupLabel }
