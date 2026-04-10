import {
  createBrowserHistory,
  createHashHistory,
  RouterProvider,
} from '@tanstack/react-router'
import ReactDOM from 'react-dom/client'

import Loader from './components/loader'
import { isElectron } from './env'
import { getRouter } from './router'

const history = isElectron ? createHashHistory() : createBrowserHistory()
const router = getRouter(history, () => <Loader />)

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
