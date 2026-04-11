/** biome-ignore-all lint: xterm integration needs imperative DOM and process event wiring. */
import type { ThreadId } from '@laborer/contracts/base'
import type { TerminalSessionSnapshot } from '@laborer/contracts/terminal'
import { FitAddon } from '@xterm/addon-fit'
import { type ITheme, Terminal } from '@xterm/xterm'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from '@/lib/terminal-links'
import {
  createTerminalId,
  type ThreadTerminalGroup,
  useThreadTerminalLayout,
} from '@/lib/thread-terminal-layout'
import { cn } from '@/lib/utils'
import { getWsRpcClient } from '@/ws-rpc-client'

interface ThreadTerminalWorkspaceProps {
  readonly cwd: string
  readonly projectName: string
  readonly threadId: ThreadId
  readonly threadTitle: string
}

interface TerminalRuntimeState {
  readonly hasRunningSubprocess: boolean
  readonly status: TerminalSessionSnapshot['status']
}

interface TerminalViewportProps {
  readonly autoFocus: boolean
  readonly cwd: string
  readonly focusRequestId: number
  readonly onActivate: () => void
  readonly terminalId: string
  readonly threadId: ThreadId
}

const DEFAULT_OPEN_COLS = 120
const DEFAULT_OPEN_ROWS = 30

const openExternalLink = async (url: string) => {
  if (window.desktopBridge?.openExternal) {
    await window.desktopBridge.openExternal(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

const writeSystemMessage = (terminal: Terminal, message: string) => {
  terminal.write(`\r\n[laborer] ${message}\r\n`)
}

const resolveTerminalTheme = (): ITheme => {
  const isDark = document.documentElement.classList.contains('dark')
  const bodyStyles = getComputedStyle(document.body)
  const background =
    bodyStyles.backgroundColor ||
    (isDark ? 'rgb(13, 17, 23)' : 'rgb(255, 255, 255)')
  const foreground =
    bodyStyles.color || (isDark ? 'rgb(230, 237, 243)' : 'rgb(31, 35, 40)')

  if (isDark) {
    return {
      background,
      black: 'rgb(33, 38, 45)',
      blue: 'rgb(121, 192, 255)',
      brightBlack: 'rgb(110, 118, 129)',
      brightBlue: 'rgb(161, 206, 255)',
      brightCyan: 'rgb(152, 245, 225)',
      brightGreen: 'rgb(86, 211, 100)',
      brightMagenta: 'rgb(255, 162, 255)',
      brightRed: 'rgb(255, 160, 166)',
      brightWhite: 'rgb(248, 250, 252)',
      brightYellow: 'rgb(255, 235, 156)',
      cursor: 'rgb(121, 192, 255)',
      cyan: 'rgb(57, 211, 192)',
      foreground,
      green: 'rgb(63, 185, 80)',
      magenta: 'rgb(215, 153, 255)',
      red: 'rgb(255, 123, 114)',
      selectionBackground: 'rgba(121, 192, 255, 0.22)',
      white: 'rgb(230, 237, 243)',
      yellow: 'rgb(210, 153, 34)',
    }
  }

  return {
    background,
    black: 'rgb(36, 41, 47)',
    blue: 'rgb(9, 105, 218)',
    brightBlack: 'rgb(101, 109, 118)',
    brightBlue: 'rgb(77, 127, 255)',
    brightCyan: 'rgb(30, 143, 123)',
    brightGreen: 'rgb(47, 129, 57)',
    brightMagenta: 'rgb(130, 80, 223)',
    brightRed: 'rgb(214, 76, 92)',
    brightWhite: 'rgb(87, 96, 106)',
    brightYellow: 'rgb(154, 103, 0)',
    cursor: 'rgb(9, 105, 218)',
    cyan: 'rgb(31, 136, 61)',
    foreground,
    green: 'rgb(26, 127, 55)',
    magenta: 'rgb(130, 80, 223)',
    red: 'rgb(207, 34, 46)',
    selectionBackground: 'rgba(9, 105, 218, 0.16)',
    white: 'rgb(87, 96, 106)',
    yellow: 'rgb(154, 103, 0)',
  }
}

const getStatusPresentation = (runtimeState?: TerminalRuntimeState) => {
  if (!runtimeState) {
    return {
      dotClassName: 'bg-muted-foreground/40',
      label: 'Idle',
      labelClassName: 'text-muted-foreground',
    }
  }

  if (runtimeState.hasRunningSubprocess) {
    return {
      dotClassName: 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.18)]',
      label: 'Busy',
      labelClassName: 'text-emerald-600 dark:text-emerald-400',
    }
  }

  switch (runtimeState.status) {
    case 'starting':
      return {
        dotClassName: 'bg-amber-500',
        label: 'Starting',
        labelClassName: 'text-amber-600 dark:text-amber-400',
      }
    case 'running':
      return {
        dotClassName: 'bg-sky-500',
        label: 'Ready',
        labelClassName: 'text-sky-600 dark:text-sky-400',
      }
    case 'error':
      return {
        dotClassName: 'bg-destructive',
        label: 'Error',
        labelClassName: 'text-destructive',
      }
    case 'exited':
      return {
        dotClassName: 'bg-muted-foreground/50',
        label: 'Exited',
        labelClassName: 'text-muted-foreground',
      }
    default:
      return {
        dotClassName: 'bg-muted-foreground/40',
        label: 'Idle',
        labelClassName: 'text-muted-foreground',
      }
  }
}

function TerminalViewport({
  autoFocus,
  cwd,
  focusRequestId,
  onActivate,
  terminalId,
  threadId,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: resolveTerminalTheme(),
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    let disposed = false
    const api = getWsRpcClient()
    const handlePointerDown = () => {
      onActivate()
    }

    const refreshTerminalSize = async () => {
      const activeTerminal = terminalRef.current
      const activeFitAddon = fitAddonRef.current
      if (!(activeTerminal && activeFitAddon)) {
        return
      }

      activeFitAddon.fit()

      try {
        await api.terminal.resize({
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          terminalId,
          threadId,
        })
      } catch {
        // Ignore resize races while the session is still starting.
      }
    }

    const renderSnapshot = (snapshot: TerminalSessionSnapshot) => {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) {
        return
      }

      activeTerminal.write('\u001bc')
      if (snapshot.history.length > 0) {
        activeTerminal.write(snapshot.history)
      }
    }

    const connect = async () => {
      const activeTerminal = terminalRef.current
      const activeFitAddon = fitAddonRef.current
      if (!(activeTerminal && activeFitAddon)) {
        return
      }

      activeFitAddon.fit()

      try {
        const snapshot = await api.terminal.open({
          cols: activeTerminal.cols,
          cwd,
          rows: activeTerminal.rows,
          terminalId,
          threadId,
        })
        if (!disposed) {
          renderSnapshot(snapshot)
        }
      } catch (error) {
        if (!disposed) {
          writeSystemMessage(
            activeTerminal,
            error instanceof Error ? error.message : 'Failed to open terminal.'
          )
        }
      }
    }

    const linkProvider = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current
        if (!activeTerminal) {
          callback(undefined)
          return
        }

        const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) {
          callback(undefined)
          return
        }

        const matches = extractTerminalLinks(line.translateToString(true))
        if (matches.length === 0) {
          callback(undefined)
          return
        }

        callback(
          matches.map((match) => ({
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) {
                return
              }

              const activeXterm = terminalRef.current
              if (!activeXterm) {
                return
              }

              if (match.kind === 'url') {
                openExternalLink(match.text).catch((error) => {
                  writeSystemMessage(
                    activeXterm,
                    error instanceof Error
                      ? error.message
                      : 'Unable to open link.'
                  )
                })
                return
              }

              api.shell
                .openInEditor({ path: resolvePathLinkTarget(match.text, cwd) })
                .catch((error) => {
                  writeSystemMessage(
                    activeXterm,
                    error instanceof Error
                      ? error.message
                      : 'Unable to open path.'
                  )
                })
            },
            range: {
              end: { x: match.end, y: bufferLineNumber },
              start: { x: match.start + 1, y: bufferLineNumber },
            },
            text: match.text,
          }))
        )
      },
    })

    const inputDisposable = terminal.onData((data) => {
      api.terminal.write({ data, terminalId, threadId }).catch((error) => {
        const activeTerminal = terminalRef.current
        if (!activeTerminal) {
          return
        }

        writeSystemMessage(
          activeTerminal,
          error instanceof Error
            ? error.message
            : 'Failed to write to terminal.'
        )
      })
    })

    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) {
        return
      }

      const activeTerminal = terminalRef.current
      if (!activeTerminal) {
        return
      }

      switch (event.type) {
        case 'output': {
          activeTerminal.write(event.data)
          return
        }
        case 'started':
        case 'restarted': {
          renderSnapshot(event.snapshot)
          return
        }
        case 'cleared': {
          activeTerminal.clear()
          activeTerminal.write('\u001bc')
          return
        }
        case 'error': {
          writeSystemMessage(activeTerminal, event.message)
          return
        }
        case 'exited': {
          const details = [
            typeof event.exitCode === 'number'
              ? `code ${event.exitCode}`
              : null,
            typeof event.exitSignal === 'number'
              ? `signal ${event.exitSignal}`
              : null,
          ]
            .filter((value): value is string => value !== null)
            .join(', ')

          writeSystemMessage(
            activeTerminal,
            details.length > 0
              ? `Process exited (${details}).`
              : 'Process exited.'
          )
          return
        }
        default:
          return
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      refreshTerminalSize().catch(() => undefined)
    })
    resizeObserver.observe(container)

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) {
        return
      }

      activeTerminal.options.theme = resolveTerminalTheme()
      activeTerminal.refresh(0, activeTerminal.rows - 1)
    })
    themeObserver.observe(document.documentElement, {
      attributeFilter: ['class', 'style'],
      attributes: true,
    })
    container.addEventListener('pointerdown', handlePointerDown)

    connect().catch(() => undefined)

    return () => {
      disposed = true
      container.removeEventListener('pointerdown', handlePointerDown)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      unsubscribe()
      linkProvider.dispose()
      inputDisposable.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      terminal.dispose()
    }
  }, [cwd, onActivate, terminalId, threadId])

  useEffect(() => {
    if (!autoFocus) {
      return
    }

    const activeTerminal = terminalRef.current
    if (!activeTerminal) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      activeTerminal.focus()
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [autoFocus, focusRequestId])

  return (
    <div
      className="h-full w-full overflow-hidden rounded-md"
      data-testid="terminal-viewport"
      ref={containerRef}
    />
  )
}

export function ThreadTerminalWorkspace({
  cwd,
  projectName,
  threadId,
  threadTitle,
}: ThreadTerminalWorkspaceProps) {
  const {
    closeTerminal,
    layout,
    newTerminal,
    setActiveTerminal,
    splitTerminal,
  } = useThreadTerminalLayout(threadId)
  const [focusRequestId, setFocusRequestId] = useState(0)
  const [runtimeByTerminalId, setRuntimeByTerminalId] = useState<
    Record<string, TerminalRuntimeState>
  >({})

  useEffect(() => {
    setFocusRequestId((current) => current + 1)
  }, [layout.activeTerminalId, threadId])

  useEffect(() => {
    const api = getWsRpcClient()
    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.threadId !== threadId) {
        return
      }

      setRuntimeByTerminalId((current) => {
        const previous = current[event.terminalId] ?? {
          hasRunningSubprocess: false,
          status: 'starting' as const,
        }

        switch (event.type) {
          case 'activity':
            return {
              ...current,
              [event.terminalId]: {
                ...previous,
                hasRunningSubprocess: event.hasRunningSubprocess,
              },
            }
          case 'started':
          case 'restarted':
            return {
              ...current,
              [event.terminalId]: {
                hasRunningSubprocess: event.snapshot.hasRunningSubprocess,
                status: event.snapshot.status,
              },
            }
          case 'exited':
            return {
              ...current,
              [event.terminalId]: {
                hasRunningSubprocess: false,
                status: 'exited',
              },
            }
          case 'error':
            return {
              ...current,
              [event.terminalId]: {
                hasRunningSubprocess: false,
                status: 'error',
              },
            }
          default:
            return current
        }
      })
    })

    return () => {
      unsubscribe()
    }
  }, [threadId])

  useEffect(() => {
    const api = getWsRpcClient()
    let cancelled = false

    const warmSessions = async () => {
      const nextStates = await Promise.all(
        layout.terminalIds.map(async (terminalId) => {
          const snapshot = await api.terminal.open({
            cols: DEFAULT_OPEN_COLS,
            cwd,
            rows: DEFAULT_OPEN_ROWS,
            terminalId,
            threadId,
          })

          return [
            terminalId,
            {
              hasRunningSubprocess: snapshot.hasRunningSubprocess,
              status: snapshot.status,
            },
          ] as const
        })
      )

      if (!cancelled) {
        setRuntimeByTerminalId((current) => ({
          ...current,
          ...Object.fromEntries(nextStates),
        }))
      }
    }

    warmSessions().catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [cwd, layout.terminalIds, threadId])

  const terminalLabelById = useMemo(
    () =>
      new Map(
        layout.terminalIds.map((terminalId, index) => [
          terminalId,
          `Terminal ${index + 1}`,
        ])
      ),
    [layout.terminalIds]
  )

  const activeGroup =
    layout.terminalGroups.find(
      (group) => group.id === layout.activeTerminalGroupId
    ) ??
    layout.terminalGroups.find((group) =>
      group.terminalIds.includes(layout.activeTerminalId)
    ) ??
    layout.terminalGroups[0]
  const visibleTerminalIds = activeGroup?.terminalIds ?? [
    layout.activeTerminalId,
  ]
  const activeRuntimeState = runtimeByTerminalId[layout.activeTerminalId]
  const activeStatus = getStatusPresentation(activeRuntimeState)
  const canCloseTerminal = layout.terminalIds.length > 1

  const createSplitTerminal = () => {
    const terminalId = createTerminalId()
    splitTerminal(terminalId)
    setRuntimeByTerminalId((current) => ({
      ...current,
      [terminalId]: { hasRunningSubprocess: false, status: 'starting' },
    }))
  }

  const createNewTerminal = () => {
    const terminalId = createTerminalId()
    newTerminal(terminalId)
    setRuntimeByTerminalId((current) => ({
      ...current,
      [terminalId]: { hasRunningSubprocess: false, status: 'starting' },
    }))
  }

  const closeSelectedTerminal = (terminalId: string) => {
    if (!canCloseTerminal) {
      return
    }

    getWsRpcClient()
      .terminal.close({ terminalId, threadId })
      .catch(() => undefined)

    closeTerminal(terminalId)
    setRuntimeByTerminalId((current) => {
      const { [terminalId]: _removed, ...rest } = current
      return rest
    })
  }

  const clearActiveTerminal = () => {
    getWsRpcClient()
      .terminal.clear({ terminalId: layout.activeTerminalId, threadId })
      .catch(() => undefined)
  }

  const restartActiveTerminal = () => {
    getWsRpcClient()
      .terminal.restart({
        cols: DEFAULT_OPEN_COLS,
        cwd,
        rows: DEFAULT_OPEN_ROWS,
        terminalId: layout.activeTerminalId,
        threadId,
      })
      .catch(() => undefined)
  }

  const renderTerminalNav = (group: ThreadTerminalGroup, compact = false) => {
    const groupActiveTerminalId = group.terminalIds.includes(
      layout.activeTerminalId
    )
      ? layout.activeTerminalId
      : (group.terminalIds[0] ?? layout.activeTerminalId)

    return (
      <div
        className={cn('space-y-1', compact && 'min-w-44 shrink-0')}
        data-group-id={group.id}
        data-testid="terminal-group"
        key={group.id}
      >
        <button
          className={cn(
            'flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[11px] uppercase tracking-[0.16em]',
            group.terminalIds.includes(layout.activeTerminalId)
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          )}
          onClick={() => setActiveTerminal(groupActiveTerminalId)}
          type="button"
        >
          <span>
            {group.terminalIds.length > 1
              ? `Split ${layout.terminalGroups.indexOf(group) + 1}`
              : `Terminal ${layout.terminalGroups.indexOf(group) + 1}`}
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {group.terminalIds.length}
          </span>
        </button>

        <div className="space-y-1">
          {group.terminalIds.map((terminalId) => {
            const runtimeState = runtimeByTerminalId[terminalId]
            const status = getStatusPresentation(runtimeState)
            const isActive = terminalId === layout.activeTerminalId

            return (
              <div
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5',
                  isActive
                    ? 'border-primary/40 bg-primary/8 text-foreground'
                    : 'border-border/60 bg-background/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                )}
                data-terminal-id={terminalId}
                data-testid="terminal-nav-item"
                key={terminalId}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setActiveTerminal(terminalId)}
                  type="button"
                >
                  <span
                    className={cn('size-2 rounded-full', status.dotClassName)}
                  />
                  <span className="truncate font-medium text-xs">
                    {terminalLabelById.get(terminalId) ?? 'Terminal'}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[11px]',
                      status.labelClassName
                    )}
                  >
                    {status.label}
                  </span>
                </button>
                {canCloseTerminal ? (
                  <button
                    className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => closeSelectedTerminal(terminalId)}
                    type="button"
                  >
                    Close
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      data-testid="thread-terminal-workspace"
    >
      <div className="border-border border-b px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn('size-2 rounded-full', activeStatus.dotClassName)}
              />
              <h2 className="truncate font-semibold text-foreground text-sm">
                {threadTitle}
              </h2>
              <span
                className={cn('text-xs', activeStatus.labelClassName)}
                data-testid="thread-terminal-status"
              >
                {activeStatus.label}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {projectName} · {cwd}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={createSplitTerminal} size="sm" variant="outline">
              Split
            </Button>
            <Button onClick={createNewTerminal} size="sm" variant="outline">
              New
            </Button>
            <Button onClick={clearActiveTerminal} size="sm" variant="ghost">
              Clear
            </Button>
            <Button onClick={restartActiveTerminal} size="sm" variant="ghost">
              Restart
            </Button>
          </div>
        </div>
      </div>

      {layout.terminalIds.length > 1 ? (
        <div className="border-border border-b px-2 py-2 md:hidden">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {layout.terminalGroups.map((group) =>
              renderTerminalNav(group, true)
            )}
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 p-2">
          {visibleTerminalIds.length > 1 ? (
            <div
              className="grid h-full gap-2"
              style={{
                gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
              }}
            >
              {visibleTerminalIds.map((terminalId) => (
                <div
                  className={cn(
                    'h-full rounded-lg border border-border/70 bg-card/40 p-1',
                    terminalId === layout.activeTerminalId &&
                      'border-primary/40 shadow-[0_0_0_1px_rgba(168,85,247,0.12)]'
                  )}
                  data-terminal-id={terminalId}
                  data-testid="terminal-pane"
                  key={terminalId}
                >
                  <TerminalViewport
                    autoFocus={terminalId === layout.activeTerminalId}
                    cwd={cwd}
                    focusRequestId={focusRequestId}
                    onActivate={() => setActiveTerminal(terminalId)}
                    terminalId={terminalId}
                    threadId={threadId}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div
              className="h-full rounded-lg border border-border/70 bg-card/40 p-1"
              data-terminal-id={
                visibleTerminalIds[0] ?? layout.activeTerminalId
              }
              data-testid="terminal-pane"
            >
              <TerminalViewport
                autoFocus
                cwd={cwd}
                focusRequestId={focusRequestId}
                onActivate={() =>
                  setActiveTerminal(
                    visibleTerminalIds[0] ?? layout.activeTerminalId
                  )
                }
                terminalId={visibleTerminalIds[0] ?? layout.activeTerminalId}
                threadId={threadId}
              />
            </div>
          )}
        </div>

        {layout.terminalIds.length > 1 ? (
          <aside
            className="hidden w-72 shrink-0 border-border border-l bg-muted/10 p-2 md:flex md:flex-col"
            data-testid="terminal-sidebar"
          >
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.16em]">
                Terminals
              </span>
              <span className="text-[11px] text-muted-foreground">
                {layout.terminalIds.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {layout.terminalGroups.map((group) => renderTerminalNav(group))}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
