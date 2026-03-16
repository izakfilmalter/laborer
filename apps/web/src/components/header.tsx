import { Link } from '@tanstack/react-router'
import { RotateCcw, Settings } from 'lucide-react'
import { useCallback } from 'react'
import { useAppSettings } from '@/components/app-settings-context'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { isElectron } from '@/lib/desktop'

import { ModeToggle } from './mode-toggle'

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
  const links = [{ to: '/', label: 'Home' }] as const
  const electron = isElectron()

  return (
    <div className={electron ? 'drag-region' : undefined}>
      <div
        className={`flex flex-row items-center justify-between px-2 ${
          electron ? 'h-[52px] pl-[80px]' : 'py-1'
        }`}
      >
        <nav className="flex gap-4 text-lg">
          {links.map(({ to, label }) => {
            return (
              <Link key={to} to={to}>
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-2">
          <ResetButton />
          <SettingsButton />
          <ModeToggle />
        </div>
      </div>
      <hr />
    </div>
  )
}
