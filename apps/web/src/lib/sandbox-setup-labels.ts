/**
 * Maps sandbox setup step keys to human-readable display labels.
 *
 * Handles both Docker steps ("building-image", "starting-container")
 * and Daytona steps ("creating-sandbox", "pushing-code", etc.),
 * as well as granular Docker build steps ("Step 4/5: RUN pnpm install").
 *
 * The step keys are stored in the `sandboxSetupStep` column of the
 * workspaces LiveStore table and emitted via `v2.SandboxSetupStepChanged`
 * events. Both Docker and Daytona providers use the same column, so the
 * UI renders labels without provider-specific conditional logic.
 *
 * @see Issue 24: Setup step progress UI for Daytona-specific steps
 */

/**
 * Returns a human-readable label for a sandbox setup step key.
 *
 * When `sandboxSetupStep` is non-null, the UI renders this label
 * alongside a spinner to indicate setup progress. When the step
 * is null, the progress indicator is cleared (setup complete).
 */
const getSandboxSetupLabel = (step: string): string => {
  // Granular Docker build steps ("Step 4/5: RUN pnpm install") are
  // passed through verbatim since they already contain useful detail.
  if (step.startsWith('Step ')) {
    return step
  }
  switch (step) {
    // Docker provider steps
    case 'building-image':
      return 'Building container image...'
    case 'starting-container':
      return 'Starting container...'
    // Daytona provider steps
    case 'creating-sandbox':
      return 'Creating sandbox...'
    case 'building-snapshot':
      return 'Building sandbox snapshot...'
    case 'pushing-code':
      return 'Pushing code to sandbox...'
    case 'configuring-ssh':
      return 'Configuring SSH access...'
    case 'starting-sandbox':
      return 'Starting sandbox...'
    default:
      return 'Setting up sandbox...'
  }
}

export { getSandboxSetupLabel }
