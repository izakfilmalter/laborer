'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeftCloseIcon, PanelLeftIcon } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

const SIDEBAR_WIDTH = '16rem'
const SIDEBAR_WIDTH_MOBILE = 'calc(100vw - var(--spacing(3)))'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'
const SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH = 16 * 16

interface SidebarContextProps {
  isMobile: boolean
  open: boolean
  openMobile: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>
  state: 'expanded' | 'collapsed'
  toggleSidebar: () => void
}

interface SidebarResizableOptions {
  maxWidth?: number
  minWidth?: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (context: {
    currentWidth: number
    nextWidth: number
    rail: HTMLButtonElement
    side: 'left' | 'right'
    sidebarRoot: HTMLElement
    wrapper: HTMLElement
  }) => boolean
  storageKey?: string
}

interface SidebarResolvedResizableOptions {
  maxWidth: number
  minWidth: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (context: {
    currentWidth: number
    nextWidth: number
    rail: HTMLButtonElement
    side: 'left' | 'right'
    sidebarRoot: HTMLElement
    wrapper: HTMLElement
  }) => boolean
  storageKey: string | null
}

interface SidebarInstanceContextProps {
  resizable: SidebarResolvedResizableOptions | null
  side: 'left' | 'right'
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)
const SidebarInstanceContext =
  React.createContext<SidebarInstanceContextProps | null>(null)

function clampSidebarWidth(
  width: number,
  options: SidebarResolvedResizableOptions
) {
  return Math.max(options.minWidth, Math.min(width, options.maxWidth))
}

function getStoredSidebarWidth(key: string) {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.localStorage.getItem(key)
  if (rawValue === null) {
    return null
  }

  const width = Number(rawValue)
  return Number.isFinite(width) ? width : null
}

function setStoredSidebarWidth(key: string, width: number) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(key, String(width))
}

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }
    },
    [setOpenProp, open]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed'

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar',
          className
        )}
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': SIDEBAR_WIDTH,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  resizable = false,
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
  resizable?: boolean | SidebarResizableOptions
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()
  const resolvedResizable =
    React.useMemo<SidebarResolvedResizableOptions | null>(() => {
      if (isMobile || collapsible === 'none' || !resizable) {
        return null
      }

      const options = typeof resizable === 'boolean' ? {} : resizable
      return {
        maxWidth: options.maxWidth ?? Number.POSITIVE_INFINITY,
        minWidth: options.minWidth ?? SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
        storageKey: options.storageKey ?? null,
        ...(options.onResize ? { onResize: options.onResize } : {}),
        ...(options.shouldAcceptWidth
          ? { shouldAcceptWidth: options.shouldAcceptWidth }
          : {}),
      }
    }, [collapsible, isMobile, resizable])
  const instanceContextValue = React.useMemo<SidebarInstanceContextProps>(
    () => ({ side, resizable: resolvedResizable }),
    [resolvedResizable, side]
  )

  if (collapsible === 'none') {
    return (
      <SidebarInstanceContext.Provider value={instanceContextValue}>
        <div
          className={cn(
            'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
            className
          )}
          data-slot="sidebar"
          {...props}
        >
          {children}
        </div>
      </SidebarInstanceContext.Provider>
    )
  }

  if (isMobile) {
    return (
      <SidebarInstanceContext.Provider value={instanceContextValue}>
        <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
          <SheetContent
            className={cn(
              'w-(--sidebar-width) max-w-none bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden',
              className
            )}
            data-mobile="true"
            data-sidebar="sidebar"
            data-slot="sidebar"
            dir={dir}
            showCloseButton={false}
            side={side}
            style={
              {
                '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      </SidebarInstanceContext.Provider>
    )
  }

  return (
    <SidebarInstanceContext.Provider value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-collapsible={state === 'collapsed' ? collapsible : ''}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
            'group-data-[collapsible=offcanvas]:w-0',
            'group-data-[side=right]:rotate-180',
            variant === 'floating' || variant === 'inset'
              ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)'
          )}
          data-slot="sidebar-gap"
        />
        <div
          className={cn(
            'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=right]:right-0 data-[side=left]:left-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] md:flex',
            // Adjust the padding for floating and inset variants.
            variant === 'floating' || variant === 'inset'
              ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
            className
          )}
          data-side={side}
          data-slot="sidebar-container"
          {...props}
        >
          <div
            className="flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 group-data-[variant=floating]:ring-sidebar-border"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarInstanceContext.Provider>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { isMobile, openMobile, toggleSidebar } = useSidebar()

  return (
    <Button
      className={cn(className)}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      size="icon-sm"
      variant="ghost"
      {...props}
    >
      {isMobile && openMobile ? <PanelLeftCloseIcon /> : <PanelLeftIcon />}
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function SidebarRail({
  className,
  onClick,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<'button'>) {
  const { open, toggleSidebar } = useSidebar()
  const sidebarInstance = React.useContext(SidebarInstanceContext)
  const railRef = React.useRef<HTMLButtonElement | null>(null)
  const suppressClickRef = React.useRef(false)
  const resizeStateRef = React.useRef<{
    moved: boolean
    pointerId: number
    pendingWidth: number
    rail: HTMLButtonElement
    rafId: number | null
    sidebarRoot: HTMLElement
    side: 'left' | 'right'
    startWidth: number
    startX: number
    transitionTargets: HTMLElement[]
    width: number
    wrapper: HTMLElement
  } | null>(null)
  const resolvedResizable = sidebarInstance?.resizable ?? null
  const canResize = resolvedResizable !== null && open
  const railLabel = canResize ? 'Resize Sidebar' : 'Toggle Sidebar'
  const railTitle = canResize ? 'Drag to resize sidebar' : 'Toggle Sidebar'

  const stopResize = React.useCallback(
    (pointerId: number) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) {
        return
      }

      if (resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId)
      }

      for (const element of resizeState.transitionTargets) {
        element.style.removeProperty('transition-duration')
      }

      if (resolvedResizable?.storageKey) {
        setStoredSidebarWidth(resolvedResizable.storageKey, resizeState.width)
      }

      resolvedResizable?.onResize?.(resizeState.width)
      resizeStateRef.current = null

      if (resizeState.rail.hasPointerCapture(pointerId)) {
        resizeState.rail.releasePointerCapture(pointerId)
      }

      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    },
    [resolvedResizable]
  )

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event)
      if (event.defaultPrevented) {
        return
      }

      if (!resolvedResizable || event.button !== 0) {
        return
      }

      if (!open) {
        return
      }

      const wrapper = event.currentTarget.closest<HTMLElement>(
        "[data-slot='sidebar-wrapper']"
      )
      const sidebarRoot = event.currentTarget.closest<HTMLElement>(
        "[data-slot='sidebar']"
      )

      if (!wrapper) {
        return
      }

      if (!sidebarRoot) {
        return
      }

      const sidebarContainer = sidebarRoot.querySelector<HTMLElement>(
        "[data-slot='sidebar-container']"
      )
      if (!sidebarContainer) {
        return
      }

      const startWidth = sidebarContainer.getBoundingClientRect().width
      const initialWidth = clampSidebarWidth(startWidth, resolvedResizable)
      const transitionTargets = [
        sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
        sidebarRoot.querySelector<HTMLElement>(
          "[data-slot='sidebar-container']"
        ),
      ].filter((element): element is HTMLElement => element !== null)

      for (const element of transitionTargets) {
        element.style.setProperty('transition-duration', '0ms')
      }

      event.preventDefault()
      event.stopPropagation()

      resizeStateRef.current = {
        moved: false,
        pointerId: event.pointerId,
        pendingWidth: initialWidth,
        rail: event.currentTarget,
        rafId: null,
        sidebarRoot,
        side: sidebarInstance?.side ?? 'left',
        startWidth: initialWidth,
        startX: event.clientX,
        transitionTargets,
        width: initialWidth,
        wrapper,
      }

      wrapper.style.setProperty('--sidebar-width', `${initialWidth}px`)
      event.currentTarget.setPointerCapture(event.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [onPointerDown, open, resolvedResizable, sidebarInstance?.side]
  )

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerMove?.(event)
      if (event.defaultPrevented) {
        return
      }

      const resizeState = resizeStateRef.current
      if (
        !resizeState ||
        resizeState.pointerId !== event.pointerId ||
        !resolvedResizable
      ) {
        return
      }

      event.preventDefault()

      const delta =
        resizeState.side === 'right'
          ? resizeState.startX - event.clientX
          : event.clientX - resizeState.startX

      if (Math.abs(delta) > 2) {
        resizeState.moved = true
      }

      resizeState.pendingWidth = clampSidebarWidth(
        resizeState.startWidth + delta,
        resolvedResizable
      )

      if (resizeState.rafId !== null) {
        return
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = resizeStateRef.current
        if (!activeResizeState) {
          return
        }

        if (!resolvedResizable) {
          return
        }

        activeResizeState.rafId = null
        const nextWidth = activeResizeState.pendingWidth
        const accepted =
          resolvedResizable.shouldAcceptWidth?.({
            currentWidth: activeResizeState.width,
            nextWidth,
            rail: activeResizeState.rail,
            side: activeResizeState.side,
            sidebarRoot: activeResizeState.sidebarRoot,
            wrapper: activeResizeState.wrapper,
          }) ?? true

        if (!accepted) {
          return
        }

        activeResizeState.wrapper.style.setProperty(
          '--sidebar-width',
          `${nextWidth}px`
        )
        activeResizeState.width = nextWidth
      })
    },
    [onPointerMove, resolvedResizable]
  )

  const endResizeInteraction = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return
      }

      event.preventDefault()
      suppressClickRef.current = resizeState.moved
      stopResize(event.pointerId)
    },
    [stopResize]
  )

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerUp?.(event)
      if (event.defaultPrevented) {
        return
      }

      endResizeInteraction(event)
    },
    [endResizeInteraction, onPointerUp]
  )

  const handlePointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerCancel?.(event)
      if (event.defaultPrevented) {
        return
      }

      endResizeInteraction(event)
    },
    [endResizeInteraction, onPointerCancel]
  )

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event)
      if (event.defaultPrevented) {
        return
      }

      if (suppressClickRef.current) {
        suppressClickRef.current = false
        event.preventDefault()
        return
      }

      if (resolvedResizable && open) {
        event.preventDefault()
        return
      }

      toggleSidebar()
    },
    [onClick, open, resolvedResizable, toggleSidebar]
  )

  React.useEffect(() => {
    if (!resolvedResizable?.storageKey) {
      return
    }

    const rail = railRef.current
    if (!rail) {
      return
    }

    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']")
    if (!wrapper) {
      return
    }

    const storedWidth = getStoredSidebarWidth(resolvedResizable.storageKey)
    if (storedWidth === null) {
      return
    }

    const clampedWidth = clampSidebarWidth(storedWidth, resolvedResizable)
    wrapper.style.setProperty('--sidebar-width', `${clampedWidth}px`)
    resolvedResizable.onResize?.(clampedWidth)
  }, [resolvedResizable])

  React.useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current

      if (resizeState && resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId)
      }

      if (resizeState) {
        for (const element of resizeState.transitionTargets) {
          element.style.removeProperty('transition-duration')
        }
      }

      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
  }, [])

  return (
    <button
      aria-label={railLabel}
      className={cn(
        'absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2 [[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none',
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:after:left-full',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className
      )}
      data-sidebar="rail"
      data-slot="sidebar-rail"
      onClick={handleClick}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={railRef}
      tabIndex={-1}
      title={railTitle}
      type="button"
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      className={cn(
        'relative flex w-full min-w-0 flex-1 flex-col bg-background md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm',
        className
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  )
}

function SidebarInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn(
        'h-8 w-full border-input bg-muted/20 dark:bg-muted/30',
        className
      )}
      data-sidebar="input"
      data-slot="sidebar-input"
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-2 p-2', className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-2 p-2', className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  )
}

function SidebarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      data-sidebar="separator"
      data-slot="sidebar-separator"
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className
      )}
      data-sidebar="content"
      data-slot="sidebar-content"
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative flex w-full min-w-0 flex-col px-2 py-1',
        className
      )}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<'div'> & React.ComponentProps<'div'>) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        className: cn(
          'flex h-8 shrink-0 items-center rounded-md px-2 text-sidebar-foreground/70 text-xs outline-hidden ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 [&>svg]:size-4 [&>svg]:shrink-0',
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: 'sidebar-group-label',
      sidebar: 'group-label',
    },
  })
}

function SidebarGroupAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<'button'> & React.ComponentProps<'button'>) {
  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        className: cn(
          'absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:hidden md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0',
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: 'sidebar-group-action',
      sidebar: 'group-action',
    },
  })
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('w-full text-xs', className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('flex w-full min-w-0 flex-col gap-px', className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      className={cn('group/menu-item relative', className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  'peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-[calc(var(--radius-sm)+2px)] p-2 text-left text-xs outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]',
      },
      size: {
        default: 'h-8 text-xs',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-xs group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

function SidebarMenuButton({
  render,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<'button'> &
  React.ComponentProps<'button'> & {
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar()
  const comp = useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props
    ),
    render: tooltip ? <TooltipTrigger render={render} /> : render,
    state: {
      slot: 'sidebar-menu-button',
      sidebar: 'menu-button',
      size,
      active: isActive,
    },
  })

  if (!tooltip) {
    return comp
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      {comp}
      <TooltipContent
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        side="right"
        {...tooltip}
      />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  render,
  showOnHover = false,
  ...props
}: useRender.ComponentProps<'button'> &
  React.ComponentProps<'button'> & {
    showOnHover?: boolean
  }) {
  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        className: cn(
          'absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0',
          showOnHover &&
            'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0',
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: 'sidebar-menu-action',
      sidebar: 'menu-action',
    },
  })
}

function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-[calc(var(--radius-sm)-2px)] px-1 font-medium text-sidebar-foreground text-xs tabular-nums peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground',
        className
      )}
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean
}) {
  // Random width between 50 to 90%.
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  })

  return (
    <div
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5 group-data-[collapsible=icon]:hidden',
        className
      )}
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  )
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<'li'>) {
  return (
    <li
      className={cn('group/menu-sub-item relative', className)}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  render,
  size = 'md',
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<'a'> &
  React.ComponentProps<'a'> & {
    size?: 'sm' | 'md'
    isActive?: boolean
  }) {
  return useRender({
    defaultTagName: 'a',
    props: mergeProps<'a'>(
      {
        className: cn(
          'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-[size=md]:text-xs data-[size=sm]:text-xs data-active:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: 'sidebar-menu-sub-button',
      sidebar: 'menu-sub-button',
      size,
      active: isActive,
    },
  })
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
