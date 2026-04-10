import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { createElement, type ReactNode } from 'react'

import { ProjectsStoreProvider } from '@/livestore/projects-store'
import { AppAtomRegistryProvider } from '@/rpc/atom-registry'
import { routeTree } from './routeTree.gen'

export const getRouter = (
  history: RouterHistory,
  defaultPendingComponent: () => ReactNode
) =>
  createRouter({
    routeTree,
    history,
    defaultPreload: 'intent',
    defaultPendingComponent,
    context: {},
    Wrap: ({ children }) =>
      createElement(
        ProjectsStoreProvider,
        undefined,
        createElement(AppAtomRegistryProvider, undefined, children)
      ),
  })

export type AppRouter = ReturnType<typeof getRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
