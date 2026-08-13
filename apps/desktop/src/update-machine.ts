import type {
  DesktopRuntimeInfo,
  DesktopUpdateState,
} from '@laborer/shared/desktop-bridge'

import {
  getCanRetryAfterDownloadFailure,
  nextStatusAfterDownloadFailure,
} from './update-state.js'

/**
 * Creates the initial update state. Starts as `disabled` — the caller
 * transitions to `idle` after verifying auto-updates are available.
 */
export function createInitialUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo
): DesktopUpdateState {
  return {
    enabled: false,
    status: 'disabled',
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Transition to `checking` when a check starts. Clears transient errors. */
export function reduceOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'checking',
    checkedAt,
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Transition to `error` when a check fails. Allows retry. */
export function reduceOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'error',
    message,
    checkedAt,
    downloadPercent: null,
    errorContext: 'check',
    canRetry: true,
  }
}

/** Transition to `available` when a new version is found. */
export function reduceOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'available',
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Transition to `up-to-date` when no update is available. Clears stale state. */
export function reduceOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'up-to-date',
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Transition to `downloading` when a download starts. */
export function reduceOnDownloadStart(
  state: DesktopUpdateState
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloading',
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Update download progress percentage. */
export function reduceOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloading',
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/**
 * Handle download failure. Falls back to `available` if the version is
 * still known (enabling retry), otherwise transitions to `error`.
 */
export function reduceOnDownloadFailure(
  state: DesktopUpdateState,
  message: string
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    errorContext: 'download',
    canRetry: getCanRetryAfterDownloadFailure(state),
  }
}

/** Transition to `downloaded` when download completes. */
export function reduceOnDownloadComplete(
  state: DesktopUpdateState,
  version: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloaded',
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  }
}

/**
 * Handle install failure. Stays in `downloaded` so the user can retry.
 */
export function reduceOnInstallFailure(
  state: DesktopUpdateState,
  message: string
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloaded',
    message,
    errorContext: 'install',
    canRetry: true,
  }
}
