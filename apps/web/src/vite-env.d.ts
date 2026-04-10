/// <reference types="vite/client" />

import type { DesktopBridge } from '@laborer/contracts/desktop'

declare global {
  interface Window {
    desktopBridge?: DesktopBridge
  }
}
