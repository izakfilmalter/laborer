import type { DesktopBridge } from '@laborer/shared/desktop-bridge'

declare global {
  interface Window {
    readonly desktopBridge?: DesktopBridge
  }
}
