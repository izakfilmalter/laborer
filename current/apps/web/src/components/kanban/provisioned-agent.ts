interface ProvisionedTaskMove {
  readonly description: string | null
  readonly workspaceId: string | null
}

type OpenAgent = (
  workspaceId: string,
  options?: { readonly initialPrompt?: string | undefined }
) => void

/** Bridge a provisioning result into the existing deferred agent-launch seam. */
export const openProvisionedAgent = (
  result: ProvisionedTaskMove,
  openAgent: OpenAgent | undefined
): void => {
  if (typeof result.workspaceId !== 'string' || openAgent === undefined) {
    return
  }
  if (result.description === null) {
    openAgent(result.workspaceId)
    return
  }
  openAgent(result.workspaceId, { initialPrompt: result.description })
}
