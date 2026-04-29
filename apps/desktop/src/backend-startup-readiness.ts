import { isBackendReadinessAborted } from './backend-readiness.js'

export interface WaitForBackendStartupReadyOptions {
  readonly cancelHttpWait: () => void
  readonly listeningPromise?: Promise<void> | null
  readonly waitForHttpReady: () => Promise<void>
}

export async function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions
): Promise<'http' | 'listening'> {
  const httpReadyPromise = options.waitForHttpReady()
  const listeningPromise = options.listeningPromise

  if (!listeningPromise) {
    await httpReadyPromise
    return 'http'
  }

  return await new Promise<'http' | 'listening'>((resolve, reject) => {
    let settled = false

    const settleResolve = (source: 'http' | 'listening') => {
      if (settled) {
        return
      }
      settled = true
      if (source === 'listening') {
        options.cancelHttpWait()
      }
      resolve(source)
    }

    const settleReject = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    listeningPromise.then(
      () => settleResolve('listening'),
      (error) => settleReject(error)
    )
    httpReadyPromise.then(
      () => settleResolve('http'),
      (error) => {
        if (settled && isBackendReadinessAborted(error)) {
          return
        }
        settleReject(error)
      }
    )
  })
}
