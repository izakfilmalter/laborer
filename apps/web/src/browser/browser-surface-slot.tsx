import { useLayoutEffect, useRef } from 'react'
import { acquireBrowserSurface } from './browser-surface-store'

export function BrowserSurfaceSlot(props: {
  readonly className?: string
  readonly cornerRadius?: number
  readonly layoutVersion?: number | string
  readonly tabId: string
  readonly visible: boolean
  readonly fitSourceContent?: boolean
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const presentationRef = useRef({
    visible: props.visible,
    cornerRadius: props.cornerRadius ?? 0,
  })
  const updateRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }
    let lease = acquireBrowserSurface(props.tabId, props.fitSourceContent)
    const update = () => {
      const rect = element.getBoundingClientRect()
      const presentation = presentationRef.current
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
      if (
        !lease.present(
          bounds,
          presentation.visible && rect.width > 0 && rect.height > 0,
          presentation.cornerRadius
        )
      ) {
        lease.release()
        lease = acquireBrowserSurface(props.tabId, props.fitSourceContent)
        lease.present(bounds, presentation.visible, presentation.cornerRadius)
      }
    }
    updateRef.current = update
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', update)
    visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      visualViewport?.removeEventListener('resize', update)
      visualViewport?.removeEventListener('scroll', update)
      lease.release()
    }
  }, [props.fitSourceContent, props.tabId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion deliberately retriggers geometry after drag, resize, and portal movement.
  useLayoutEffect(() => {
    presentationRef.current = {
      visible: props.visible,
      cornerRadius: props.cornerRadius ?? 0,
    }
    updateRef.current?.()
  }, [props.cornerRadius, props.layoutVersion, props.visible])

  return (
    <div
      className={props.className}
      data-browser-surface-slot={props.tabId}
      ref={elementRef}
    />
  )
}
