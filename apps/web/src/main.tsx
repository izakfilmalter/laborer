import {
  createBrowserHistory,
  createHashHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import ReactDOM from 'react-dom/client'

import Loader from './components/loader'
import { isElectron } from './env'
import { routeTree } from './routeTree.gen'

const history = isElectron ? createHashHistory() : createBrowserHistory()

const router = createRouter({
  routeTree,
  history,
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

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
}
