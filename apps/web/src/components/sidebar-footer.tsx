import { Button } from '@laborer/ui/components/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { RotateCcw, Settings } from 'lucide-react'
import { useCallback } from 'react'
import { useAppSettings } from '@/components/app-settings-context'
import { DesktopUpdatePill } from '@/components/desktop-update-pill'

import { ModeToggle } from './mode-toggle'
import { ServiceStatusDots } from './service-status-dots'
import { ConnectedSlackDaemonStatusButton } from './slack-daemon-status-button'

function ResetButton() {
  const handleReset = useCallback(() => {
    const url = new URL(globalThis.location.href)
    url.searchParams.set('reset', '')
    globalThis.location.href = url.toString()
  }, [])

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button onClick={handleReset} size="icon" variant="outline" />}
      >
        <RotateCcw className="h-[1.2rem] w-[1.2rem]" />
        <span className="sr-only">Reset persistence</span>
      </TooltipTrigger>
      <TooltipContent>Reset persistence</TooltipContent>
    </Tooltip>
  )
}

function SettingsButton() {
  const { onOpenChange } = useAppSettings()

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-testid="open-app-settings"
            onClick={() => onOpenChange(true)}
            size="icon"
            variant="outline"
          />
        }
      >
        <Settings className="h-[1.2rem] w-[1.2rem]" />
        <span className="sr-only">Settings</span>
      </TooltipTrigger>
      <TooltipContent>Settings</TooltipContent>
    </Tooltip>
  )
}

export function SidebarFooter() {
  return (
    <div className="grid gap-2 border-t p-3">
      <DesktopUpdatePill />
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ServiceStatusDots />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectedSlackDaemonStatusButton />
          <ResetButton />
          <SettingsButton />
          <ModeToggle />
        </div>
      </div>
    </div>
  )
}
