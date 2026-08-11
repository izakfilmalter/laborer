/** biome-ignore-all lint: throwaway prototype for issue #407 — not production code */
/**
 * PROTOTYPE (#407) — standalone entry. Served by the normal web dev server:
 *
 *   bun run --cwd current/apps/web dev
 *   open http://localhost:2101/proto-kanban-drag.html
 *
 * Deliberately not a router route: __root.tsx mounts the sidecar/LiveStore
 * providers, which a browser-only prototype must not depend on.
 */
import { RegistryContext } from '@effect-atom/atom-react/RegistryContext'
import { createRoot } from 'react-dom/client'
import { ProtoApp } from './app'
import { registry } from './sim'

import '../index.css'

const root = document.getElementById('root')
if (root) {
  // No StrictMode: the app root doesn't use it, and dnd-kit's
  // MeasuringStrategy.Always loops under StrictMode's double layout effects.
  createRoot(root).render(
    <RegistryContext.Provider value={registry}>
      <ProtoApp />
    </RegistryContext.Provider>
  )
}
