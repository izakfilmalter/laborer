// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module name.
import { createHash } from 'node:crypto'
import { type Session, session } from 'electron'

const PREVIEW_PARTITION_PREFIX = 'persist:laborer-preview-'
const ELECTRON_USER_AGENT_PATTERN = /Electron\/[\d.]+ /
const LABORER_USER_AGENT_PATTERN = /\s*Laborer\/[\d.]+/i

const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'geolocation',
])

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
])

/** Accept the certificate despite Chromium's verdict. */
const VERIFY_RESULT_ACCEPT = 0
/** Defer to Chromium's own certificate verification result. */
const VERIFY_RESULT_USE_CHROMIUM = -3

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

export class BrowserSession {
  readonly #sessions = new Map<string, Session>()

  getPartition(scope = 'shared'): string {
    const digest = createHash('sha256').update(scope).digest('hex').slice(0, 20)
    return `${PREVIEW_PARTITION_PREFIX}${digest}`
  }

  isPartition(partition: string): boolean {
    return partition.startsWith(PREVIEW_PARTITION_PREFIX)
  }

  getSession(scope = 'shared'): Session {
    const partition = this.getPartition(scope)
    const existing = this.#sessions.get(partition)
    if (existing) {
      return existing
    }

    const browserSession = session.fromPartition(partition)
    const userAgent = browserSession
      .getUserAgent()
      .replace(ELECTRON_USER_AGENT_PATTERN, '')
      .replace(LABORER_USER_AGENT_PATTERN, '')
    browserSession.setUserAgent(userAgent)
    browserSession.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission))
      }
    )
    browserSession.setPermissionCheckHandler((_webContents, permission) =>
      ALLOWED_PREVIEW_PERMISSIONS.has(permission)
    )
    // Dev servers (for example `https://localhost:3000` with a self-signed
    // certificate) would otherwise fail silently: Electron webviews render
    // nothing instead of Chrome's interstitial. Trust is scoped to loopback
    // hosts within preview partitions; everything else keeps Chromium's
    // verdict.
    browserSession.setCertificateVerifyProc((request, callback) => {
      callback(
        isLoopbackHostname(request.hostname)
          ? VERIFY_RESULT_ACCEPT
          : VERIFY_RESULT_USE_CHROMIUM
      )
    })
    this.#sessions.set(partition, browserSession)
    return browserSession
  }

  async clearCookies(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((browserSession) =>
        browserSession.clearStorageData({
          storages: [
            'cookies',
            'localstorage',
            'indexdb',
            'websql',
            'serviceworkers',
          ],
        })
      )
    )
  }

  async clearCache(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((browserSession) =>
        browserSession.clearCache()
      )
    )
  }
}
