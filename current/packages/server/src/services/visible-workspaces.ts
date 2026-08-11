/**
 * visible-workspaces — Server-side helper
 *
 * Panel layout is renderer-local UI state. Server-side polling services do
 * not derive window visibility from renderer-local state.
 */

/**
 * Return the set of backend-visible workspace IDs. Since renderer panel layout
 * does not sync to the backend, all workspaces are treated as background work.
 */
const getVisibleWorkspaceIds = (): ReadonlySet<string> => {
  // Treat all workspaces as background from server code.
  return new Set<string>()
}

export { getVisibleWorkspaceIds }
