/**
 * Stateful fake for `@/components/ui/resizable` used by workspace frame
 * tests.
 *
 * Emulates the react-resizable-panels v4 behaviors that matter for
 * workspace minimize handling (verified against the library source):
 *
 * - Layouts are cached per panel-id-set: when the set of registered panels
 *   changes (e.g. a workspace is added), the layout is rebuilt from each
 *   panel's `defaultSize`. This is what un-collapses minimized panels in
 *   the real library.
 * - The imperative `collapse()`/`expand()` APIs resize against the adjacent
 *   panel only (neighbor pivot) — freed space is NOT distributed.
 * - `onLayoutChanged` fires after layout rebuilds and imperative changes.
 * - `groupRef` exposes `getLayout()`/`setLayout()`.
 *
 * Panels render `data-panel-id` and `data-size` attributes so tests can
 * assert on the resulting layout.
 */

import type { ReactNode, Ref } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

/** Percentage assigned to a collapsed panel (stands in for "2.5rem"). */
export const COLLAPSED_PCT = 4

type Layout = Record<string, number>

interface PanelRegistration {
  readonly collapsible: boolean
  readonly defaultSize: number | undefined
  readonly id: string
}

interface PanelHandle {
  collapse: () => void
  expand: () => void
  getSize: () => { asPercentage: number; inPixels: number }
  isCollapsed: () => boolean
  resize: (size: number | string) => void
}

interface GroupApi {
  collapse: (id: string) => void
  expand: (id: string) => void
  getSize: (id: string) => number | undefined
  isCollapsed: (id: string) => boolean
  registerPanel: (reg: PanelRegistration) => () => void
}

interface GroupContextValue {
  readonly api: GroupApi
  readonly layout: Layout
}

const GroupContext = createContext<GroupContextValue | null>(null)

function parseSize(size: number | string | undefined): number | undefined {
  if (size === undefined) {
    return undefined
  }
  const parsed = typeof size === 'number' ? size : Number.parseFloat(size)
  return Number.isFinite(parsed) ? parsed : undefined
}

function approxEqual(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 0.001
}

export function ResizablePanelGroup({
  children,
  groupRef,
  onLayoutChanged,
}: {
  readonly children?: ReactNode
  readonly groupRef?: Ref<{
    getLayout: () => Layout
    setLayout: (layout: Layout) => Layout
  } | null>
  readonly onLayoutChanged?: (layout: Layout) => void
  readonly [key: string]: unknown
}) {
  const panelsRef = useRef<PanelRegistration[]>([])
  const layoutRef = useRef<Layout>({})
  const expandToSizesRef = useRef(new Map<string, number>())
  const panelSetKeyRef = useRef<string | null>(null)
  const [renderedLayout, setRenderedLayout] = useState<Layout>({})
  const [version, setVersion] = useState(0)

  const onLayoutChangedRef = useRef(onLayoutChanged)
  onLayoutChangedRef.current = onLayoutChanged

  const applyLayout = useCallback((next: Layout) => {
    layoutRef.current = next
    setRenderedLayout(next)
    onLayoutChangedRef.current?.(next)
  }, [])

  const api: GroupApi = useMemo(
    () => ({
      registerPanel: (reg: PanelRegistration) => {
        panelsRef.current = [...panelsRef.current, reg]
        setVersion((v) => v + 1)
        return () => {
          panelsRef.current = panelsRef.current.filter((p) => p !== reg)
          setVersion((v) => v + 1)
        }
      },
      collapse: (id: string) => {
        const current = layoutRef.current
        const size = current[id]
        if (size === undefined || approxEqual(size, COLLAPSED_PCT)) {
          return
        }
        expandToSizesRef.current.set(id, size)
        const ids = panelsRef.current.map((p) => p.id)
        const index = ids.indexOf(id)
        const neighbor = ids[index + 1] ?? ids[index - 1]
        const next: Layout = { ...current, [id]: COLLAPSED_PCT }
        if (neighbor !== undefined) {
          next[neighbor] = (next[neighbor] ?? 0) + (size - COLLAPSED_PCT)
        }
        applyLayout(next)
      },
      expand: (id: string) => {
        const current = layoutRef.current
        const size = current[id]
        if (size === undefined || !approxEqual(size, COLLAPSED_PCT)) {
          return
        }
        const restored = expandToSizesRef.current.get(id) ?? COLLAPSED_PCT
        const ids = panelsRef.current.map((p) => p.id)
        const index = ids.indexOf(id)
        const neighbor = ids[index + 1] ?? ids[index - 1]
        const next: Layout = { ...current, [id]: restored }
        if (neighbor !== undefined) {
          next[neighbor] = (next[neighbor] ?? 0) - (restored - COLLAPSED_PCT)
        }
        applyLayout(next)
      },
      isCollapsed: (id: string) =>
        approxEqual(layoutRef.current[id], COLLAPSED_PCT),
      getSize: (id: string) => layoutRef.current[id],
    }),
    [applyLayout]
  )

  // Rebuild the layout from panel defaults whenever the panel set changes.
  // This mirrors react-resizable-panels: layouts are cached per panel-id-set,
  // so a new set falls back to defaultSize props.
  useEffect(() => {
    const panels = panelsRef.current
    const key = panels.map((p) => p.id).join(',')
    if (key === panelSetKeyRef.current) {
      return
    }
    panelSetKeyRef.current = key
    if (panels.length === 0) {
      return
    }
    const next: Layout = {}
    for (const panel of panels) {
      next[panel.id] = panel.defaultSize ?? 100 / panels.length
    }
    const total = Object.values(next).reduce((sum, v) => sum + v, 0)
    if (total > 0) {
      for (const id of Object.keys(next)) {
        const value = next[id] ?? 0
        next[id] = (value / total) * 100
      }
    }
    applyLayout(next)
  }, [version, applyLayout])

  // Expose the imperative group handle (getLayout/setLayout).
  useEffect(() => {
    if (!groupRef) {
      return
    }
    const handle = {
      getLayout: () => ({ ...layoutRef.current }),
      setLayout: (layout: Layout) => {
        applyLayout({ ...layout })
        return { ...layout }
      },
    }
    if (typeof groupRef === 'function') {
      groupRef(handle)
      return () => groupRef(null)
    }
    groupRef.current = handle
    return () => {
      groupRef.current = null
    }
  }, [groupRef, applyLayout])

  const contextValue: GroupContextValue = useMemo(
    () => ({ api, layout: renderedLayout }),
    [api, renderedLayout]
  )

  return (
    <GroupContext.Provider value={contextValue}>
      <div data-testid="resizable-panel-group">{children}</div>
    </GroupContext.Provider>
  )
}

export function ResizablePanel({
  children,
  collapsible,
  collapsedSize,
  defaultSize,
  id,
  panelRef,
}: {
  readonly children?: ReactNode
  readonly collapsible?: boolean
  readonly collapsedSize?: number | string
  readonly defaultSize?: number | string
  readonly id?: string | number
  readonly panelRef?: Ref<PanelHandle | null>
  readonly [key: string]: unknown
}) {
  const context = useContext(GroupContext)
  const autoId = useId()
  const panelId = id !== undefined ? String(id) : autoId
  const apiRef = useRef(context?.api)
  apiRef.current = context?.api

  // Register with the parent group (mirrors Panel's useLayoutEffect
  // registration in the real library).
  useEffect(() => {
    const api = apiRef.current
    if (!api) {
      return
    }
    return api.registerPanel({
      id: panelId,
      defaultSize: parseSize(defaultSize),
      collapsible: collapsible === true,
    })
  }, [panelId, defaultSize, collapsible])

  // Expose the imperative panel handle.
  useEffect(() => {
    if (!panelRef) {
      return
    }
    const handle: PanelHandle = {
      collapse: () => apiRef.current?.collapse(panelId),
      expand: () => apiRef.current?.expand(panelId),
      getSize: () => ({
        asPercentage: apiRef.current?.getSize(panelId) ?? 0,
        inPixels: 0,
      }),
      isCollapsed: () => apiRef.current?.isCollapsed(panelId) ?? false,
      resize: () => undefined,
    }
    if (typeof panelRef === 'function') {
      panelRef(handle)
      return () => panelRef(null)
    }
    panelRef.current = handle
    return () => {
      panelRef.current = null
    }
  }, [panelRef, panelId])

  const size = context?.layout[panelId]

  return (
    <div
      data-collapsed-size={collapsedSize ?? ''}
      data-collapsible={collapsible ? 'true' : 'false'}
      data-panel-id={panelId}
      data-size={size === undefined ? '' : size.toFixed(1)}
      data-testid="resizable-panel"
    >
      {children}
    </div>
  )
}

export function ResizableHandle() {
  return <div data-testid="resize-handle" />
}
