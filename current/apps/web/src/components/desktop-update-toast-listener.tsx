import type { DesktopUpdateState } from '@laborer/shared/desktop-bridge'
import { Cause, Effect, Exit, Option, pipe } from 'effect'
import { useEffect, useRef } from 'react'
import { isElectron } from '@/lib/desktop'
import {
  type DesktopUpdateError,
  downloadDesktopUpdate,
  installDesktopUpdate,
  useDesktopUpdateState,
} from '@/lib/desktop-update'
import { toast } from '@/lib/toast'

function showDesktopUpdateError(error: DesktopUpdateError): void {
  if (error._tag === 'DesktopUpdateInstallCancelledError') {
    return
  }

  if (
    error._tag === 'DesktopUpdateInstallError' ||
    (error._tag === 'DesktopUpdateActionRejectedError' &&
      error.action === 'install')
  ) {
    toast.error('Could not install update', { description: error.message })
    return
  }

  toast.error('Could not download update', { description: error.message })
}

function showDesktopUpdateCause(cause: Cause.Cause<DesktopUpdateError>): void {
  pipe(
    Cause.failureOption(cause),
    Option.match({
      onNone: () =>
        toast.error('Update failed', { description: Cause.pretty(cause) }),
      onSome: showDesktopUpdateError,
    })
  )
}

function handleDownloadUpdate(): void {
  Effect.runPromiseExit(downloadDesktopUpdate()).then((exit) => {
    pipe(
      exit,
      Exit.match({
        onFailure: showDesktopUpdateCause,
        onSuccess: (result) => {
          if (result.completed) {
            toast.success('Update downloaded', {
              description:
                'Restart the app from the update button to install it.',
            })
          }
        },
      })
    )
  })
}

function handleInstallUpdate(state: DesktopUpdateState): void {
  Effect.runPromiseExit(installDesktopUpdate(state)).then((exit) => {
    pipe(
      exit,
      Exit.match({
        onFailure: showDesktopUpdateCause,
        onSuccess: () => undefined,
      })
    )
  })
}

export function DesktopUpdateToastListener(): null {
  const state = useDesktopUpdateState()
  const promptedAvailableVersionRef = useRef<string | null>(null)
  const promptedDownloadedVersionRef = useRef<string | null>(null)

  useEffect(() => {
    if (!(isElectron() && state?.enabled)) {
      return
    }

    if (state.status === 'available' && state.availableVersion) {
      if (promptedAvailableVersionRef.current === state.availableVersion) {
        return
      }
      promptedAvailableVersionRef.current = state.availableVersion

      toast.info('Update available', {
        action: {
          label: 'Update now',
          onClick: handleDownloadUpdate,
        },
        description: `Laborer ${state.availableVersion} is ready to download.`,
        duration: Number.POSITIVE_INFINITY,
      })
      return
    }

    if (state.status === 'downloaded' && state.downloadedVersion) {
      if (promptedDownloadedVersionRef.current === state.downloadedVersion) {
        return
      }
      promptedDownloadedVersionRef.current = state.downloadedVersion

      toast.success('Update ready to install', {
        action: {
          label: 'Restart now',
          onClick: () => handleInstallUpdate(state),
        },
        description: `Laborer ${state.downloadedVersion} has been downloaded.`,
        duration: Number.POSITIVE_INFINITY,
      })
    }
  }, [state])

  return null
}
