export interface PromptEpochEventStream<T> {
  readonly next: () => Promise<IteratorResult<T>>
  readonly return?: (value?: undefined) => Promise<IteratorResult<T>>
}

export const openPromptEpochEventStream = async <T>(options: {
  readonly publishEpoch: () => Promise<void>
  readonly subscribe: () => PromptEpochEventStream<T>
}): Promise<PromptEpochEventStream<T>> => {
  await options.publishEpoch()
  const stream = options.subscribe()
  try {
    const connected = await stream.next()
    if (connected.done) {
      throw new Error(
        'OpenCode event stream disconnected before prompt admission'
      )
    }
    return stream
  } catch (cause) {
    await stream.return?.(undefined).catch(() => undefined)
    throw cause
  }
}
