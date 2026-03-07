/**
 * AtomRegistryProvider — Wraps the React tree with the effect-atom Registry.
 *
 * The RegistryProvider from @effect-atom/atom-react creates a Registry
 * instance that manages atom subscriptions, lifecycle, and the Effect
 * runtime for AtomRpc clients.
 *
 * Place this inside ThemeProvider and alongside LiveStoreProvider in the
 * root layout so all components have access to both systems.
 *
 * @see Issue #20: AtomRpc client setup
 */

import { RegistryProvider } from '@effect-atom/atom-react/RegistryContext'
import type { ReactNode } from 'react'

export function AtomRegistryProvider({ children }: { children: ReactNode }) {
  return <RegistryProvider>{children}</RegistryProvider>
}
