import { RotateCcw, Settings } from 'lucide-react'
import { useCallback } from 'react'
import { useAppSettings } from '@/components/app-settings-context'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { ModeToggle } from './mode-toggle'
import { ServiceStatusDots } from './service-status-dots'

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
    <div className="flex items-center gap-2 border-t p-3">
      <div className="min-w-0 flex-1">
        <ServiceStatusDots />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ResetButton />
        <SettingsButton />
        <ModeToggle />
      </div>
    </div>
  )
}
