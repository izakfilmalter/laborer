/// <reference types="vite/client" />

import type { DesktopBridge } from '@laborer/contracts/desktop'

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge
  }
}
