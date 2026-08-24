'use client'

import { cn } from '@laborer/ui/lib/utils'
// biome-ignore lint/performance/noNamespaceImport: shadcn/ui component
import * as ResizablePrimitive from 'react-resizable-panels'

function ResizeGrip({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none z-10 flex h-8 w-1.5 shrink-0 items-center justify-center text-muted-foreground/55 transition-colors duration-150 group-hover:text-foreground/85 group-focus-visible:text-foreground group-active:text-foreground',
        className
      )}
    >
      <span className="flex gap-px">
        <span className="h-6 w-px rounded-full bg-current" />
        <span className="h-6 w-px rounded-full bg-current" />
      </span>
    </span>
  )
}

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      className={cn(
        'flex h-full w-full aria-[orientation=vertical]:flex-col',
        className
      )}
      data-slot="resizable-panel-group"
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      className={cn(
        'group relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>span]:rotate-90',
        className
      )}
      data-slot="resizable-handle"
      {...props}
    >
      {withHandle && <ResizeGrip />}
    </ResizablePrimitive.Separator>
  )
}

export { ResizeGrip, ResizableHandle, ResizablePanel, ResizablePanelGroup }
