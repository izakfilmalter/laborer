export interface AsyncOutputQueue {
  readonly end: () => void
  readonly fail: (cause: unknown) => void
  readonly iterable: AsyncIterable<string>
  readonly offer: (value: string) => void
}

/** A process-local bridge to an AsyncIterable, with no replay or durability. */
export const makeAsyncOutputQueue = (): AsyncOutputQueue => {
  const values: string[] = []
  const waiters: Array<{
    readonly reject: (cause: unknown) => void
    readonly resolve: (result: IteratorResult<string>) => void
  }> = []
  let ended = false
  let failed = false
  let failure: unknown

  const settle = (): void => {
    while (waiters.length > 0 && values.length > 0) {
      waiters.shift()?.resolve({ done: false, value: values.shift() ?? '' })
    }
    if (failed) {
      while (waiters.length > 0) {
        waiters.shift()?.reject(failure)
      }
    } else if (ended) {
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ done: true, value: undefined })
      }
    }
  }

  return {
    end: () => {
      ended = true
      settle()
    },
    fail: (cause) => {
      failed = true
      failure = cause
      settle()
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (values.length > 0) {
              return Promise.resolve({
                done: false as const,
                value: values.shift() ?? '',
              })
            }
            if (failed) {
              return Promise.reject(failure)
            }
            if (ended) {
              return Promise.resolve({
                done: true as const,
                value: undefined,
              })
            }
            return new Promise<IteratorResult<string>>((resolve, reject) => {
              waiters.push({ reject, resolve })
            })
          },
        }
      },
    },
    offer: (value) => {
      values.push(value)
      settle()
    },
  }
}
