// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import type {
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTarget,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from '@laborer/shared/desktop-bridge'
import type { WebContents } from 'electron'
import { PREVIEW_POINTER_EVENT_CHANNEL } from './channels.js'

const MAX_EVALUATION_BYTES = 64_000
const MAX_VISIBLE_TEXT_LENGTH = 20_000
const MAX_INTERACTIVE_ELEMENTS = 200
const MAX_SCREENSHOT_WIDTH = 1280
const ROLE_LOCATOR_PATTERN =
  /^role=([^[]+)(?:\[name=(?:'([^']*)'|"([^"]*)")\])?$/
const KEY_MODIFIERS = {
  Alt: 'alt',
  Control: 'control',
  Meta: 'meta',
  Shift: 'shift',
} as const satisfies Record<
  NonNullable<PreviewAutomationPressInput['modifiers']>[number],
  NonNullable<Electron.KeyboardInputEvent['modifiers']>[number]
>

type RequireGuest = (owner: WebContents, tabId: string) => WebContents
type GetPointerOwner = (tabId: string) => WebContents | null
type DebuggerSend = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>

export class PreviewAutomation {
  readonly #getPointerOwner: GetPointerOwner
  readonly #requireGuest: RequireGuest
  #pointerSequence = 0

  constructor(options: {
    getPointerOwner: GetPointerOwner
    requireGuest: RequireGuest
  }) {
    this.#getPointerOwner = options.getPointerOwner
    this.#requireGuest = options.requireGuest
  }

  openDevTools(owner: WebContents, tabId: string): void {
    const guest = this.#requireGuest(owner, tabId)
    if (guest.debugger.isAttached()) {
      guest.debugger.detach()
    }
    if (guest.isDevToolsOpened()) {
      guest.devToolsWebContents?.focus()
    } else {
      guest.openDevTools({ mode: 'detach' })
    }
  }

  async applyColorScheme(
    guest: WebContents,
    colorScheme: DesktopPreviewColorScheme
  ): Promise<void> {
    await this.#withDebugger(guest, (send) =>
      send('Emulation.setEmulatedMedia', {
        features: [
          {
            name: 'prefers-color-scheme',
            value: colorScheme === 'system' ? '' : colorScheme,
          },
        ],
      })
    )
  }

  async snapshot(
    owner: WebContents,
    tabId: string
  ): Promise<PreviewAutomationSnapshot> {
    const guest = this.#requireGuest(owner, tabId)
    return await this.#withDebugger(guest, async (send) => {
      const page = (await this.#evaluate(
        send,
        `(() => {
        const selectorFor = (element) => {
          if (element.id) return '#' + CSS.escape(element.id)
          const testId = element.getAttribute('data-testid')
          if (testId) return element.tagName.toLowerCase() + '[data-testid=' + JSON.stringify(testId) + ']'
          return element.tagName.toLowerCase()
        }
        const visible = (element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        }
        return {
          url: location.href,
          title: document.title,
          loading: document.readyState !== 'complete',
          visibleText: (document.body?.innerText || '').slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
          interactiveElements: Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]')).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect()
            return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: element.getAttribute('aria-label') || element.innerText || element.getAttribute('name') || '', selector: selectorFor(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })
        }
      })()`
      )) as Omit<
        PreviewAutomationSnapshot,
        | 'accessibilityTree'
        | 'actionTimeline'
        | 'consoleEntries'
        | 'networkEntries'
        | 'screenshot'
      >
      const [accessibilityTree, sourceImage] = await Promise.all([
        send('Accessibility.getFullAXTree'),
        guest.capturePage(),
      ])
      const sourceSize = sourceImage.getSize()
      const image =
        sourceSize.width > MAX_SCREENSHOT_WIDTH
          ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
          : sourceImage
      const size = image.getSize()
      return {
        ...page,
        accessibilityTree,
        actionTimeline: [],
        consoleEntries: [],
        networkEntries: [],
        screenshot: {
          data: image.toPNG().toString('base64'),
          height: size.height,
          mimeType: 'image/png',
          width: size.width,
        },
      }
    })
  }

  async click(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationClickInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const point =
        typeof input.x === 'number' && typeof input.y === 'number'
          ? { x: input.x, y: input.y }
          : ((await this.#evaluate(
              send,
              `(() => { const element = ${this.#elementExpression(input)}; if (!element) return null; element.scrollIntoView({block:'center',inline:'center'}); const rect=element.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2} })()`
            )) as { x: number; y: number } | null)
      if (!(point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
        throw new Error('Preview automation target was not found')
      }
      this.#emitPointer(tabId, 'move', point.x, point.y)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      this.#emitPointer(tabId, 'click', point.x, point.y)
      await send('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mousePressed',
        ...point,
      })
      await send('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mouseReleased',
        ...point,
      })
    })
  }

  async type(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationTypeInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const result = await this.#evaluate(
        send,
        `(() => { const element=${this.#elementExpression(input, true)}; if (!element) return 'not-found'; const editable=element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element.isContentEditable; if (!editable||element.disabled||element.readOnly) return 'not-editable'; element.focus(); const text=${JSON.stringify(input.text)}; if (${input.clear === true}) { if ('value' in element) element.value=''; else element.textContent=''; } if ('value' in element) element.value += text; else element.textContent=(element.textContent||'')+text; element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text})); element.dispatchEvent(new Event('change',{bubbles:true})); return 'ok' })()`
      )
      if (result !== 'ok') {
        throw new Error(`Preview automation target is ${String(result)}`)
      }
    })
  }

  press(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationPressInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    const modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> =
      input.modifiers?.map((modifier) => KEY_MODIFIERS[modifier]) ?? []
    guest.sendInputEvent({
      keyCode: input.key,
      modifiers,
      type: 'keyDown',
    })
    guest.sendInputEvent({
      keyCode: input.key,
      modifiers,
      type: 'keyUp',
    })
    return Promise.resolve()
  }

  async scroll(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationScrollInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const result = await this.#evaluate(
        send,
        `(() => { const target=${this.#elementExpression(input, true, 'window')}; if (!target) return false; target.scrollBy({left:${input.deltaX ?? 0},top:${input.deltaY ?? 0},behavior:'instant'}); return true })()`
      )
      if (result !== true) {
        throw new Error('Preview automation scroll target was not found')
      }
    })
  }

  async evaluate(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationEvaluateInput
  ): Promise<unknown> {
    const guest = this.#requireGuest(owner, tabId)
    if (
      input.expression.length === 0 ||
      input.expression.length > MAX_EVALUATION_BYTES
    ) {
      throw new Error('Invalid preview evaluation expression')
    }
    return await this.#withDebugger(guest, async (send) => {
      const value = await this.#evaluate(
        send,
        input.expression,
        input.awaitPromise ?? true,
        input.returnByValue ?? true
      )
      if (
        Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') >
        MAX_EVALUATION_BYTES
      ) {
        throw new Error('Preview evaluation result is too large')
      }
      return value
    })
  }

  async waitFor(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationWaitForInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 1), 60_000)
    await this.#withDebugger(guest, async (send) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() <= deadline) {
        const matched = await this.#evaluate(
          send,
          `(() => Boolean(${this.#elementExpression(input, true, 'true')}) && ${input.text ? `(document.body?.innerText||'').includes(${JSON.stringify(input.text)})` : 'true'} && ${input.urlIncludes ? `location.href.includes(${JSON.stringify(input.urlIncludes)})` : 'true'})()`
        )
        if (matched === true) {
          return
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
      throw new Error(`Preview condition did not match within ${timeoutMs}ms`)
    })
  }

  async #withDebugger<A>(
    guest: WebContents,
    use: (send: DebuggerSend) => Promise<A>
  ): Promise<A> {
    if (guest.isDevToolsOpened()) {
      throw new Error('Close preview DevTools before using browser automation')
    }
    if (guest.debugger.isAttached()) {
      throw new Error('Another debugger owns this preview webview')
    }
    guest.debugger.attach('1.3')
    const send: DebuggerSend = (method, params) =>
      guest.debugger.sendCommand(method, params)
    try {
      await Promise.all([send('Runtime.enable'), send('Accessibility.enable')])
      return await use(send)
    } finally {
      if (guest.debugger.isAttached()) {
        guest.debugger.detach()
      }
    }
  }

  async #evaluate(
    send: DebuggerSend,
    expression: string,
    awaitPromise = true,
    returnByValue = true
  ): Promise<unknown> {
    const response = (await send('Runtime.evaluate', {
      awaitPromise,
      expression,
      returnByValue,
      userGesture: true,
    })) as {
      exceptionDetails?: { exception?: { description?: string }; text?: string }
      result?: { value?: unknown }
    }
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Preview evaluation failed'
      )
    }
    return response.result?.value
  }

  #elementExpression(
    input: PreviewAutomationTarget,
    optional = false,
    fallback = 'null'
  ): string {
    const raw = input.locator ?? input.selector
    if (!raw) {
      return optional ? fallback : 'null'
    }
    const locator = raw.trim()
    if (locator.startsWith('css=')) {
      return `document.querySelector(${JSON.stringify(locator.slice(4))})`
    }
    const role = ROLE_LOCATOR_PATTERN.exec(locator)
    if (role) {
      const roleName = role[1]
      const accessibleName = role[2] ?? role[3]
      let nativeSelector = '*'
      if (roleName === 'button') {
        nativeSelector = 'button'
      } else if (roleName === 'textbox') {
        nativeSelector = 'input,textarea'
      }
      return `Array.from(document.querySelectorAll('[role=${JSON.stringify(roleName)}],${nativeSelector}')).find((element)=>${accessibleName === undefined ? 'true' : `(element.getAttribute('aria-label')||element.textContent||'').trim()===${JSON.stringify(accessibleName)}`})||null`
    }
    if (locator.startsWith('text=')) {
      return `Array.from(document.querySelectorAll('*')).find((element)=>element.textContent?.includes(${JSON.stringify(locator.slice(5))}))||null`
    }
    return `document.querySelector(${JSON.stringify(locator)})`
  }

  #emitPointer(
    tabId: string,
    phase: 'click' | 'move',
    x: number,
    y: number
  ): void {
    const owner = this.#getPointerOwner(tabId)
    if (!owner) {
      return
    }
    const event: DesktopPreviewPointerEvent = {
      createdAt: new Date().toISOString(),
      phase,
      sequence: this.#pointerSequence++,
      tabId,
      x,
      y,
    }
    owner.send(PREVIEW_POINTER_EVENT_CHANNEL, event)
  }
}
