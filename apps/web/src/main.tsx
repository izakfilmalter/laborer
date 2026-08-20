import { installInteractiveTapFallback } from '@laborer/ui/lib/haptics'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import ReactDOM from 'react-dom/client'

import Loader from './components/loader'
import { routeTree } from './routeTree.gen'

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => <Loader />,
  context: {},
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Root element not found')
}

// Baseline tap for one-off `<button>`s that do not use the shared primitives.
// Components declaring a richer haptic still win — see the module docs.
installInteractiveTapFallback()

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
}
