import { Cause, Effect, Exit, Option, pipe } from 'effect'
import { DownloadIcon, RotateCwIcon, XIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  type DesktopUpdateError,
  downloadDesktopUpdate,
  getDesktopUpdateButtonTooltip,
  installDesktopUpdate,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowDesktopUpdateButton,
  useDesktopUpdateState,
} from '@/lib/desktop-update'
import { localApi } from '@/lib/local-api'
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
    Cause.findErrorOption(cause),
    Option.match({
      onNone: () =>
        toast.error('Update failed', { description: Cause.pretty(cause) }),
      onSome: showDesktopUpdateError,
    })
  )
}

function DesktopUpdatePillLabel({
  action,
  state,
}: {
  readonly action: string
  readonly state: ReturnType<typeof useDesktopUpdateState>
}) {
  if (action === 'install') {
    return (
      <>
        <RotateCwIcon className="size-3.5" />
        <span>Restart to update</span>
      </>
    )
  }

  if (state?.status === 'downloading') {
    return (
      <>
        <DownloadIcon className="size-3.5" />
        <span>
          Downloading
          {typeof state.downloadPercent === 'number'
            ? ` (${Math.floor(state.downloadPercent)}%)`
            : '...'}
        </span>
      </>
    )
  }

  return (
    <>
      <DownloadIcon className="size-3.5" />
      <span>Update available</span>
    </>
  )
}

export function DesktopUpdatePill() {
  const state = useDesktopUpdateState()
  const [dismissed, setDismissed] = useState(false)

  const visible =
    localApi.isDesktop && shouldShowDesktopUpdateButton(state) && !dismissed
  const tooltip = state
    ? getDesktopUpdateButtonTooltip(state)
    : 'Update available'
  const disabled = isDesktopUpdateButtonDisabled(state)
  const action = state ? resolveDesktopUpdateButtonAction(state) : 'none'

  const handleAction = useCallback(() => {
    if (!state) {
      return
    }
    if (disabled || action === 'none') {
      return
    }

    if (action === 'download') {
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
      return
    }

    if (action === 'install') {
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
  }, [action, disabled, state])

  if (!visible) {
    return null
  }

  return (
    <div className="group/update relative flex h-7 w-full items-center rounded-lg bg-primary/15 font-medium text-primary text-xs">
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors group-has-[button.update-main:hover]/update:bg-primary/22" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-disabled={disabled || undefined}
              aria-label={tooltip}
              className="update-main relative flex h-full flex-1 items-center gap-2 px-2 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              onClick={handleAction}
              type="button"
            >
              <DesktopUpdatePillLabel action={action} state={state} />
            </button>
          }
        />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      {action === 'download' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Dismiss update"
                className="relative mr-1 size-5 rounded-md text-primary/60 hover:text-primary"
                onClick={() => setDismissed(true)}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Dismiss until next launch</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
