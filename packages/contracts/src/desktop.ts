export interface ContextMenuItem<T extends string = string> {
  readonly destructive?: boolean
  readonly disabled?: boolean
  readonly id: T
  readonly label: string
}

export type DesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type DesktopRuntimeArch = 'arm64' | 'x64' | 'other'
export type DesktopTheme = 'light' | 'dark' | 'system'

export interface DesktopUpdateState {
  readonly appArch: DesktopRuntimeArch
  readonly availableVersion: string | null
  readonly canRetry: boolean
  readonly checkedAt: string | null
  readonly currentVersion: string
  readonly downloadedVersion: string | null
  readonly downloadPercent: number | null
  readonly enabled: boolean
  readonly errorContext: 'check' | 'download' | 'install' | null
  readonly hostArch: DesktopRuntimeArch
  readonly message: string | null
  readonly runningUnderArm64Translation: boolean
  readonly status: DesktopUpdateStatus
}

export interface DesktopUpdateActionResult {
  readonly accepted: boolean
  readonly completed: boolean
  readonly state: DesktopUpdateState
}

export interface DesktopUpdateCheckResult {
  readonly checked: boolean
  readonly state: DesktopUpdateState
}

export interface DesktopBridge {
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>
  confirm: (message: string) => Promise<boolean>
  downloadUpdate: () => Promise<DesktopUpdateActionResult>
  getUpdateState: () => Promise<DesktopUpdateState>
  getWsUrl: () => string | null
  installUpdate: () => Promise<DesktopUpdateActionResult>
  onMenuAction: (listener: (action: string) => void) => () => void
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void
  openExternal: (url: string) => Promise<boolean>
  pickFolder: () => Promise<string | null>
  setTheme: (theme: DesktopTheme) => Promise<void>
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number }
  ) => Promise<T | null>
}
