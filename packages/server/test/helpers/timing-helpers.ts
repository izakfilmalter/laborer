export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const waitFor = async (
  assertion: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await assertion()) {
      return
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for condition')
}
