// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import { fileURLToPath } from 'node:url'
import type { WebPreferences } from 'electron'

interface AttachmentEvent {
  preventDefault(): void
}

interface PreviewWebviewPolicy {
  readonly isApprovedPartition: (partition: string) => boolean
  readonly preloadUrl: string
}

interface WebviewAttachmentParams {
  readonly partition?: string
  readonly preload?: string
}

export function enforcePreviewWebviewSecurity(
  event: AttachmentEvent,
  webPreferences: WebPreferences,
  params: WebviewAttachmentParams,
  policy: PreviewWebviewPolicy | null
): boolean {
  if (
    !policy ||
    typeof params.partition !== 'string' ||
    !policy.isApprovedPartition(params.partition) ||
    params.preload !== policy.preloadUrl
  ) {
    event.preventDefault()
    return false
  }

  let preloadPath: string
  try {
    preloadPath = fileURLToPath(policy.preloadUrl)
  } catch {
    event.preventDefault()
    return false
  }

  webPreferences.allowRunningInsecureContent = false
  webPreferences.contextIsolation = true
  webPreferences.experimentalFeatures = false
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.preload = preloadPath
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.webviewTag = false
  webPreferences.enableBlinkFeatures = ''
  return true
}
