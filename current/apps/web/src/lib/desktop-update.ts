import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from '@laborer/shared/desktop-bridge'
import { Effect, Schema } from 'effect'
import { useEffect, useState } from 'react'
import { getDesktopBridge } from '@/lib/desktop'

class DesktopUpdateBridgeUnavailableError extends Schema.TaggedErrorClass<DesktopUpdateBridgeUnavailableError>()(
  'DesktopUpdateBridgeUnavailableError',
  {
    message: Schema.String,
  }
) {}

class DesktopUpdateDownloadError extends Schema.TaggedErrorClass<DesktopUpdateDownloadError>()(
  'DesktopUpdateDownloadError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  }
) {}

class DesktopUpdateInstallError extends Schema.TaggedErrorClass<DesktopUpdateInstallError>()(
  'DesktopUpdateInstallError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  }
) {}

class DesktopUpdateActionRejectedError extends Schema.TaggedErrorClass<DesktopUpdateActionRejectedError>()(
  'DesktopUpdateActionRejectedError',
  {
    action: Schema.Literals(['download', 'install']),
    message: Schema.String,
  }
) {}

class DesktopUpdateInstallCancelledError extends Schema.TaggedErrorClass<DesktopUpdateInstallCancelledError>()(
  'DesktopUpdateInstallCancelledError',
  {
    message: Schema.String,
  }
) {}

export type DesktopUpdateError =
  | DesktopUpdateActionRejectedError
  | DesktopUpdateBridgeUnavailableError
  | DesktopUpdateDownloadError
  | DesktopUpdateInstallCancelledError
  | DesktopUpdateInstallError

export type DesktopUpdateButtonAction = 'download' | 'install' | 'none'

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return 'install'
  }
  if (state.status === 'available') {
    return 'download'
  }
  if (
    state.status === 'error' &&
    state.errorContext === 'download' &&
    state.availableVersion
  ) {
    return 'download'
  }
  return 'none'
}

export function shouldShowDesktopUpdateButton(
  state: DesktopUpdateState | null
): boolean {
  if (!state?.enabled) {
    return false
  }
  if (state.status === 'downloading') {
    return true
  }
  return resolveDesktopUpdateButtonAction(state) !== 'none'
}

export function isDesktopUpdateButtonDisabled(
  state: DesktopUpdateState | null
): boolean {
  return state?.status === 'downloading'
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState
): string {
  if (state.status === 'available') {
    return `Update ${state.availableVersion ?? 'available'} ready to download`
  }
  if (state.status === 'downloading') {
    const progress =
      typeof state.downloadPercent === 'number'
        ? ` (${Math.floor(state.downloadPercent)}%)`
        : ''
    return `Downloading update${progress}`
  }
  if (state.status === 'downloaded') {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? 'ready'} downloaded. Click to restart and install.`
  }
  if (state.status === 'error') {
    if (state.errorContext === 'download' && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`
    }
    if (state.errorContext === 'install' && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`
    }
    return state.message ?? 'Update failed'
  }
  return 'Up to date'
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, 'availableVersion' | 'downloadedVersion'>
): string {
  const version = state.downloadedVersion ?? state.availableVersion
  return `Install update${version ? ` ${version}` : ''} and restart Laborer?\n\nAny running processes will be interrupted. Make sure you're ready before continuing.`
}

export function getDesktopUpdateActionError(
  result: DesktopUpdateActionResult
): string | null {
  if (!result.accepted || result.completed) {
    return null
  }
  if (typeof result.state.message !== 'string') {
    return null
  }
  const message = result.state.message.trim()
  return message.length > 0 ? message : null
}

export function shouldToastDesktopUpdateActionResult(
  result: DesktopUpdateActionResult
): boolean {
  return getDesktopUpdateActionError(result) !== null
}

function desktopBridge() {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return new DesktopUpdateBridgeUnavailableError({
      message: 'Desktop update bridge is unavailable.',
    })
  }
  return Effect.succeed(bridge)
}

function validateUpdateActionResult(
  action: 'download' | 'install',
  result: DesktopUpdateActionResult
) {
  const actionError = getDesktopUpdateActionError(result)
  if (actionError) {
    return new DesktopUpdateActionRejectedError({
      action,
      message: actionError,
    })
  }
  return Effect.succeed(result)
}

export const downloadDesktopUpdate = Effect.fn('downloadDesktopUpdate')(
  function* () {
    const bridge = yield* desktopBridge()
    const result = yield* Effect.tryPromise({
      try: () => bridge.downloadUpdate(),
      catch: (cause) =>
        new DesktopUpdateDownloadError({
          cause,
          message: 'Could not start update download.',
        }),
    })
    return yield* validateUpdateActionResult('download', result)
  }
)

export const installDesktopUpdate = Effect.fn('installDesktopUpdate')(
  function* (state: DesktopUpdateState) {
    const bridge = yield* desktopBridge()
    const confirmed = yield* Effect.tryPromise({
      try: () =>
        bridge.confirm(getDesktopUpdateInstallConfirmationMessage(state)),
      catch: (cause) =>
        new DesktopUpdateInstallError({
          cause,
          message: 'Could not confirm update install.',
        }),
    })

    if (!confirmed) {
      return yield* new DesktopUpdateInstallCancelledError({
        message: 'Update install cancelled.',
      })
    }

    const result = yield* Effect.tryPromise({
      try: () => bridge.installUpdate(),
      catch: (cause) =>
        new DesktopUpdateInstallError({
          cause,
          message: 'Could not install update.',
        }),
    })
    return yield* validateUpdateActionResult('install', result)
  }
)

export function useDesktopUpdateState(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    let disposed = false
    let receivedSubscriptionUpdate = false
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) {
        return
      }
      receivedSubscriptionUpdate = true
      setState(nextState)
    })

    bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) {
          return
        }
        setState(nextState)
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return state
}
