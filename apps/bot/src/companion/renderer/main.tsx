import {
  createHashHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { routeTree } from './routeTree.gen.ts'
import { initializeStatusStore } from './status-store.ts'
import './styles.css'

const router = createRouter({
  history: createHashHistory(),
  routeTree,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

initializeStatusStore()
const rootElement = document.querySelector('#app')
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Laborer companion root is missing')
}
createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
