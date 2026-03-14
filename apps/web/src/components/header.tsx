import { RotateCcw } from 'lucide-react'
import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { isElectron } from '@/lib/desktop'

import { ModeToggle } from './mode-toggle'
import { ServiceStatusPills } from './service-status-pills'

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

export default function Header() {
  const electron = isElectron()

  return (
    <div className={electron ? 'drag-region' : undefined}>
      <div
        className={`flex flex-row items-center justify-between px-2 ${
          electron ? 'h-[52px] pl-[80px]' : 'py-1'
        }`}
      >
        <span className="font-medium text-lg">laborer</span>
        <div className="flex items-center gap-2">
          <ServiceStatusPills />
          <ResetButton />
          <ModeToggle />
        </div>
      </div>
      <hr />
    </div>
  )
}
