export interface WaitForHttpReadyOptions {
  readonly fetchImpl?: typeof fetch
  readonly intervalMs?: number
  readonly isReady?: (response: Response) => boolean
  readonly path?: string
  readonly requestTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

const DEFAULT_INTERVAL_MS = 100
const DEFAULT_REQUEST_TIMEOUT_MS = 1000
const DEFAULT_TIMEOUT_MS = 30_000

export class BackendReadinessAbortedError extends Error {
  constructor() {
    super('Backend readiness wait was aborted.')
    this.name = 'BackendReadinessAbortedError'
  }
}

interface HttpReadyAttemptOptions {
  readonly baseUrl: string
  readonly fetchImpl: typeof fetch
  readonly isReady: (response: Response) => boolean
  readonly readinessPath: string
  readonly requestTimeoutMs: number
  readonly signal: AbortSignal | undefined
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      cleanup()
      reject(new BackendReadinessAbortedError())
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (signal?.aborted) {
      cleanup()
      reject(new BackendReadinessAbortedError())
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isBackendReadinessAborted(
  error: unknown
): error is BackendReadinessAbortedError {
  return error instanceof BackendReadinessAbortedError
}

async function checkHttpReady({
  baseUrl,
  fetchImpl,
  isReady,
  readinessPath,
  requestTimeoutMs,
  signal,
}: HttpReadyAttemptOptions): Promise<boolean> {
  if (signal?.aborted) {
    throw new BackendReadinessAbortedError()
  }

  const requestController = new AbortController()
  const requestTimeout = setTimeout(() => {
    requestController.abort()
  }, requestTimeoutMs)
  const abortRequest = () => {
    requestController.abort()
  }
  signal?.addEventListener('abort', abortRequest, { once: true })

  try {
    const response = await fetchImpl(
      new URL(readinessPath, baseUrl).toString(),
      {
        redirect: 'manual',
        signal: requestController.signal,
      }
    )
    return isReady(response)
  } catch (error) {
    if (isBackendReadinessAborted(error)) {
      throw error
    }
    if (signal?.aborted) {
      throw new BackendReadinessAbortedError()
    }
    return false
  } finally {
    clearTimeout(requestTimeout)
    signal?.removeEventListener('abort', abortRequest)
  }
}

export async function waitForHttpReady(
  baseUrl: string,
  options?: WaitForHttpReadyOptions
): Promise<void> {
  const fetchImpl = options?.fetchImpl ?? fetch
  const signal = options?.signal
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
  const requestTimeoutMs =
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const readinessPath = options?.path ?? '/'
  const isReady = options?.isReady ?? ((response: Response) => response.ok)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (
      await checkHttpReady({
        baseUrl,
        fetchImpl,
        isReady,
        readinessPath,
        requestTimeoutMs,
        signal,
      })
    ) {
      return
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for backend readiness at ${baseUrl}.`)
    }

    await delay(intervalMs, signal)
  }
}
