// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewScreenshotArtifact,
  PreviewAnnotationSubmissionResult,
} from '@laborer/shared/desktop-bridge'
import { PreviewElementPickedEventSchema } from '@laborer/shared/desktop-bridge'
import { Option, Schema } from 'effect'
import { clipboard, nativeImage, shell, type WebContents } from 'electron'
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from './channels.js'

const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  accent: 'rgb(0 0 0 / 4%)',
  accentForeground: 'oklch(0.269 0 0)',
  background: 'white',
  border: 'rgb(0 0 0 / 8%)',
  colorScheme: 'light',
  fontMono: 'ui-monospace, monospace',
  fontSans: 'system-ui, sans-serif',
  foreground: 'oklch(0.269 0 0)',
  input: 'rgb(0 0 0 / 10%)',
  muted: 'rgb(0 0 0 / 4%)',
  mutedForeground: 'oklch(0.556 0 0)',
  popover: 'white',
  popoverForeground: 'oklch(0.269 0 0)',
  primary: 'oklch(0.488 0.217 264)',
  primaryForeground: 'white',
  radius: '0.625rem',
  ring: 'oklch(0.488 0.217 264)',
}

interface PickSession {
  readonly cancel: () => void
  readonly promise: Promise<PreviewAnnotationSubmissionResult | null>
}

export class PreviewArtifacts {
  readonly #artifactDirectory: string
  readonly #forEachGuest: (use: (guest: WebContents) => void) => void
  readonly #pickSessions = new Map<string, PickSession>()
  #annotationTheme = DEFAULT_ANNOTATION_THEME

  constructor(options: {
    artifactDirectory: string
    forEachGuest: (use: (guest: WebContents) => void) => void
  }) {
    this.#artifactDirectory = resolve(options.artifactDirectory)
    this.#forEachGuest = options.forEachGuest
  }

  get annotationTheme(): DesktopPreviewAnnotationTheme {
    return this.#annotationTheme
  }

  setAnnotationTheme(theme: DesktopPreviewAnnotationTheme): void {
    this.#annotationTheme = theme
    this.#forEachGuest((guest) => guest.send(ANNOTATION_THEME_CHANNEL, theme))
  }

  pickElement(
    tabId: string,
    guest: WebContents
  ): Promise<PreviewAnnotationSubmissionResult | null> {
    this.cancelPickElement(tabId)

    let settle: (value: PreviewAnnotationSubmissionResult | null) => void =
      () => undefined
    const promise = new Promise<PreviewAnnotationSubmissionResult | null>(
      (resolvePromise) => {
        settle = resolvePromise
      }
    )
    const cleanup = () => {
      guest.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onPicked)
      guest.removeListener('destroyed', onCancelled)
      guest.removeListener('did-start-navigation', onCancelled)
      this.#pickSessions.delete(tabId)
    }
    const finish = (result: PreviewAnnotationSubmissionResult | null) => {
      cleanup()
      settle(result)
    }
    const onCancelled = () => finish(null)
    const onPicked = async (_event: unknown, ...args: unknown[]) => {
      const decoded = Option.getOrUndefined(
        Schema.decodeUnknownOption(PreviewElementPickedEventSchema)(args)
      )
      if (!decoded || decoded[0] === null) {
        finish(null)
        return
      }
      const [payload, rect, submission] = decoded
      try {
        const image = await guest.capturePage({
          height: Math.ceil(rect.height),
          width: Math.ceil(rect.width),
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
        })
        const size = image.getSize()
        finish({
          annotation: {
            ...payload,
            screenshot: {
              cropRect: rect ?? {
                height: size.height,
                width: size.width,
                x: 0,
                y: 0,
              },
              dataUrl: image.toDataURL(),
              height: size.height,
              width: size.width,
            },
          },
          submission,
        })
      } catch {
        finish({ annotation: payload, submission })
      } finally {
        if (!guest.isDestroyed()) {
          guest.send(ANNOTATION_CAPTURED_CHANNEL)
        }
      }
    }
    const session: PickSession = {
      cancel: () => {
        cleanup()
        if (!guest.isDestroyed()) {
          guest.send(CANCEL_PICK_CHANNEL)
        }
        settle(null)
      },
      promise,
    }
    this.#pickSessions.set(tabId, session)
    guest.ipc.on(ELEMENT_PICKED_CHANNEL, onPicked)
    guest.once('destroyed', onCancelled)
    guest.once('did-start-navigation', onCancelled)
    guest.focus()
    guest.send(START_PICK_CHANNEL, this.#annotationTheme)
    return promise
  }

  cancelPickElement(tabId: string): void {
    this.#pickSessions.get(tabId)?.cancel()
  }

  async captureScreenshot(
    tabId: string,
    guest: WebContents
  ): Promise<DesktopPreviewScreenshotArtifact> {
    const image = await guest.capturePage()
    const data = image.toPNG()
    const createdAt = new Date().toISOString()
    const id = `browser-screenshot-${Date.now().toString(36)}`
    const path = join(this.#artifactDirectory, `${id}.png`)
    await mkdir(this.#artifactDirectory, { recursive: true })
    await writeFile(path, data)
    return {
      createdAt,
      id,
      mimeType: 'image/png',
      path,
      sizeBytes: data.byteLength,
      tabId,
    }
  }

  async saveRecording(
    tabId: string,
    mimeType: string,
    data: Uint8Array
  ): Promise<DesktopPreviewRecordingArtifact> {
    const createdAt = new Date().toISOString()
    const id = `browser-recording-${Date.now().toString(36)}`
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const path = join(this.#artifactDirectory, `${id}.${extension}`)
    await mkdir(this.#artifactDirectory, { recursive: true })
    await writeFile(path, data)
    return { createdAt, id, mimeType, path, sizeBytes: data.byteLength, tabId }
  }

  revealArtifact(path: string): void {
    shell.showItemInFolder(this.#resolveArtifact(path))
  }

  async copyArtifactToClipboard(path: string): Promise<void> {
    const data = await readFile(this.#resolveArtifact(path))
    const image = nativeImage.createFromBuffer(data)
    if (image.isEmpty()) {
      throw new Error('Preview artifact is not an image')
    }
    clipboard.writeImage(image)
  }

  #resolveArtifact(path: string): string {
    const resolvedPath = resolve(path)
    const relativePath = relative(this.#artifactDirectory, resolvedPath)
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error('Preview artifact path is outside the artifact directory')
    }
    return resolvedPath
  }
}
