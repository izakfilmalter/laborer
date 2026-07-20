/**
 * visible-workspaces — Server-side helper
 *
 * Panel layout is renderer-local UI state and is stored in a LiveStore client
 * document. Client documents are not synced to the backend, so server-side
 * polling services cannot derive actual window visibility from LiveStore.
 */

import type { LaborerStore } from './laborer-store.js'

/**
 * Return the set of backend-visible workspace IDs. Since renderer panel layout
 * does not sync to the backend, all workspaces are treated as background work.
 */
const getVisibleWorkspaceIds = (
  _store: LaborerStore['Type']['store']
): ReadonlySet<string> => {
  // Panel layout is a renderer-local LiveStore client document and is not
  // synced to the backend. Treat all workspaces as background from server code.
  return new Set<string>()
}

export { getVisibleWorkspaceIds }
