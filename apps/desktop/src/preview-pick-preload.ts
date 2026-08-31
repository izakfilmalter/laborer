import type {
  DesktopPreviewAnnotationTheme,
  PickedElementPayload,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from '@laborer/shared/desktop-bridge'
import { ipcRenderer } from 'electron'
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  MOUSE_NAVIGATE_CHANNEL,
  START_PICK_CHANNEL,
} from './preview/channels.js'

const OVERLAY_ATTRIBUTE = 'data-laborer-preview-picker'
let teardownPicker: (() => void) | null = null
let annotationTheme: DesktopPreviewAnnotationTheme | null = null

function selectorFor(element: Element): string | null {
  if (element.id) {
    return `#${CSS.escape(element.id)}`
  }
  const testId = element.getAttribute('data-testid')
  if (testId) {
    return `${element.tagName.toLowerCase()}[data-testid=${JSON.stringify(testId)}]`
  }
  const parts: string[] = []
  let current: Element | null = element
  while (current && parts.length < 8) {
    const parent: Element | null = current.parentElement
    const tag = current.tagName.toLowerCase()
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.tagName === current?.tagName
    )
    const part =
      siblings.length > 1
        ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})`
        : tag
    parts.unshift(part)
    current = parent
  }
  return parts.join(' > ') || null
}

function describeElement(element: Element): PickedElementPayload {
  const stack: PickedElementPayload['stack'] = []
  return {
    componentName: null,
    htmlPreview: element.outerHTML.slice(0, 4000),
    pageTitle: document.title.trim() || null,
    pageUrl: location.href,
    pickedAt: new Date().toISOString(),
    selector: selectorFor(element),
    source: null,
    stack,
    styles: element instanceof HTMLElement ? element.style.cssText : '',
    tagName: element.tagName.toLowerCase(),
  }
}

function startPicker(theme?: DesktopPreviewAnnotationTheme): void {
  teardownPicker?.()
  annotationTheme = theme ?? annotationTheme

  const overlay = document.createElement('div')
  overlay.setAttribute(OVERLAY_ATTRIBUTE, '')
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483646',
    'border:2px solid transparent',
    'background:transparent',
    'box-sizing:border-box',
  ].join(';')
  document.documentElement.appendChild(overlay)

  const move = (event: PointerEvent) => {
    const element = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((candidate) => !candidate.hasAttribute(OVERLAY_ATTRIBUTE))
    if (!element) {
      overlay.style.display = 'none'
      return
    }
    const rect = element.getBoundingClientRect()
    overlay.style.display = 'block'
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    overlay.style.borderColor = annotationTheme?.primary ?? '#4f46e5'
    overlay.style.background = 'rgb(79 70 229 / 10%)'
  }
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerdown', pick, true)
    window.removeEventListener('keydown', keydown, true)
    overlay.remove()
    if (teardownPicker === cleanup) {
      teardownPicker = null
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    cleanup()
    ipcRenderer.send(ELEMENT_PICKED_CHANNEL, null)
  }
  const pick = (event: PointerEvent) => {
    const element = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((candidate) => !candidate.hasAttribute(OVERLAY_ATTRIBUTE))
    if (!element) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    const domRect = element.getBoundingClientRect()
    const rect: PreviewAnnotationRect = {
      height: domRect.height,
      width: domRect.width,
      x: domRect.x,
      y: domRect.y,
    }
    const annotation: PreviewAnnotationPayload = {
      comment: '',
      createdAt: new Date().toISOString(),
      elements: [
        {
          element: describeElement(element),
          id: 'element_1',
          rect,
        },
      ],
      id: `annotation_${Date.now().toString(36)}`,
      pageTitle: document.title.trim() || null,
      pageUrl: location.href,
      regions: [],
      screenshot: null,
      strokes: [],
      styleChanges: [],
    }
    cleanup()
    ipcRenderer.send(ELEMENT_PICKED_CHANNEL, annotation, rect, 'attach')
  }

  teardownPicker = cleanup
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerdown', pick, true)
  window.addEventListener('keydown', keydown, true)
}

window.addEventListener(
  'pointerdown',
  (event) => {
    if (event.isTrusted) {
      ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
        button: event.button,
        kind: 'pointer',
        x: event.clientX,
        y: event.clientY,
      })
    }
  },
  true
)
window.addEventListener(
  'keydown',
  (event) => {
    if (event.isTrusted) {
      ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
        code: event.code,
        key: event.key,
        kind: 'key',
      })
    }
  },
  true
)

for (const eventName of ['mousedown', 'mouseup', 'auxclick'] as const) {
  window.addEventListener(
    eventName,
    (event) => {
      if (!event.isTrusted || (event.button !== 3 && event.button !== 4)) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (eventName === 'mouseup') {
        ipcRenderer.send(MOUSE_NAVIGATE_CHANNEL, {
          direction: event.button === 3 ? 'back' : 'forward',
        })
      }
    },
    true
  )
}

ipcRenderer.on(
  START_PICK_CHANNEL,
  (_event, theme: DesktopPreviewAnnotationTheme | undefined) => {
    if (theme) {
      annotationTheme = theme
    }
    startPicker(theme)
  }
)
ipcRenderer.on(CANCEL_PICK_CHANNEL, () => teardownPicker?.())
ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, () => teardownPicker?.())
ipcRenderer.on(
  ANNOTATION_THEME_CHANNEL,
  (_event, theme: DesktopPreviewAnnotationTheme) => {
    annotationTheme = theme
  }
)
