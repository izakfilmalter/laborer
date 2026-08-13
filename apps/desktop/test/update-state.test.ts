import type { DesktopUpdateState } from '@laborer/shared/desktop-bridge'
import { describe, expect, it } from 'vitest'

import {
  getAutoUpdateDisabledReason,
  getCanRetryAfterDownloadFailure,
  nextStatusAfterDownloadFailure,
  shouldBroadcastDownloadProgress,
} from '../src/update-state.js'

const baseState: DesktopUpdateState = {
  enabled: true,
  status: 'idle',
  currentVersion: '1.0.0',
  hostArch: 'x64',
  appArch: 'x64',
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
}

describe('shouldBroadcastDownloadProgress', () => {
  it('broadcasts the first downloading progress update', () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: 'downloading', downloadPercent: null },
        1
      )
    ).toBe(true)
  })

  it('skips progress updates within the same 10% bucket', () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: 'downloading', downloadPercent: 11.2 },
        18.7
      )
    ).toBe(false)
  })

  it('broadcasts progress updates when a new 10% bucket is reached', () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: 'downloading', downloadPercent: 19.9 },
        20.1
      )
    ).toBe(true)
  })

  it('broadcasts when a retry resets the download percentage', () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: 'downloading', downloadPercent: 50.4 },
        0.2
      )
    ).toBe(true)
  })

  it('always broadcasts the final 100% update', () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: 'downloading', downloadPercent: 95 },
        100
      )
    ).toBe(true)
  })
})

describe('getAutoUpdateDisabledReason', () => {
  it('reports development builds as disabled', () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: true,
        isPackaged: false,
        platform: 'darwin',
        disabledByEnv: false,
      })
    ).toContain('packaged production builds')
  })

  it('reports env-disabled auto updates', () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: 'darwin',
        disabledByEnv: true,
      })
    ).toContain('LABORER_DISABLE_AUTO_UPDATE')
  })

  it('reports linux as unsupported', () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: 'linux',
        disabledByEnv: false,
      })
    ).toContain('Linux')
  })

  it('returns null for packaged macOS builds without env override', () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: 'darwin',
        disabledByEnv: false,
      })
    ).toBeNull()
  })
})

describe('nextStatusAfterDownloadFailure', () => {
  it('returns available when an update version is still known', () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: 'downloading',
        availableVersion: '1.1.0',
      })
    ).toBe('available')
  })

  it('returns error when no update version can be retried', () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: 'downloading',
        availableVersion: null,
      })
    ).toBe('error')
  })
})

describe('getCanRetryAfterDownloadFailure', () => {
  it('returns true when an available version is still present', () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: 'downloading',
        availableVersion: '1.1.0',
      })
    ).toBe(true)
  })

  it('returns false when no version is available to retry', () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: 'downloading',
        availableVersion: null,
      })
    ).toBe(false)
  })
})
