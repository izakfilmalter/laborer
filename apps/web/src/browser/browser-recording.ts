import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
} from '@laborer/shared/desktop-bridge'
import { create } from 'zustand'

interface Recording {
  readonly canvas: HTMLCanvasElement
  readonly chunks: Blob[]
  readonly context: CanvasRenderingContext2D
  readonly recorder: MediaRecorder
  readonly tabId: string
}

interface RecordingStore {
  readonly activeTabId: string | null
  readonly setActiveTabId: (tabId: string | null) => void
}

export const useBrowserRecordingStore = create<RecordingStore>()((set) => ({
  activeTabId: null,
  setActiveTabId: (activeTabId) => set({ activeTabId }),
}))

let active: Recording | null = null
let unsubscribeFrames: (() => void) | null = null

const drawFrame = (frame: DesktopPreviewRecordingFrame) => {
  if (!active || frame.tabId !== active.tabId) {
    return
  }
  const recording = active
  const image = new Image()
  image.addEventListener(
    'load',
    () => {
      if (active !== recording) {
        return
      }
      const width = Math.max(1, Math.round(frame.width))
      const height = Math.max(1, Math.round(frame.height))
      if (
        recording.canvas.width !== width ||
        recording.canvas.height !== height
      ) {
        recording.canvas.width = width
        recording.canvas.height = height
      }
      recording.context.drawImage(image, 0, 0, width, height)
    },
    { once: true }
  )
  image.src = `data:image/jpeg;base64,${frame.data}`
}

const preferredMimeType = () => {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/webm;codecs=vp9',
    'video/webm',
  ]
  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    'video/webm'
  )
}

export async function startBrowserRecording(tabId: string): Promise<void> {
  const preview = window.desktopBridge?.preview
  if (!preview || active) {
    throw new Error('Browser recording is unavailable or already active.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Browser recording canvas is unavailable.')
  }
  const mimeType = preferredMimeType()
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType })
  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  })
  active = { canvas, chunks, context, recorder, tabId }
  unsubscribeFrames ??= preview.recording.onFrame(drawFrame)
  try {
    await preview.recording.startScreencast(tabId)
    recorder.start(1000)
    useBrowserRecordingStore.getState().setActiveTabId(tabId)
  } catch (error) {
    active = null
    unsubscribeFrames?.()
    unsubscribeFrames = null
    throw error
  }
}

export async function stopBrowserRecording(): Promise<DesktopPreviewRecordingArtifact | null> {
  const preview = window.desktopBridge?.preview
  const recording = active
  if (!(preview && recording)) {
    return null
  }
  active = null
  useBrowserRecordingStore.getState().setActiveTabId(null)
  await preview.recording.stopScreencast(recording.tabId)
  const stopped = new Promise<void>((resolve) =>
    recording.recorder.addEventListener('stop', () => resolve(), { once: true })
  )
  recording.recorder.stop()
  await stopped
  unsubscribeFrames?.()
  unsubscribeFrames = null
  const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType })
  return preview.recording.save(
    recording.tabId,
    recording.recorder.mimeType,
    new Uint8Array(await blob.arrayBuffer())
  )
}
