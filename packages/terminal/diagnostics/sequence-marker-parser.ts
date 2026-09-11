export interface SequenceMarkerParser {
  readonly write: (data: string) => readonly number[]
}

/**
 * Incrementally extracts complete sequence markers without bounding a new
 * transport frame before it has been searched. Only the unmatched suffix is
 * retained, so a single large coalesced Delta cannot manufacture packet loss.
 */
export const createSequenceMarkerParser = (
  prefix: string,
  maximumSuffixChars = 8192
): SequenceMarkerParser => {
  const pattern = new RegExp(`${prefix}(\\d+)__`, 'g')
  let suffix = ''

  return {
    write: (data) => {
      const input = suffix + data
      const sequences: number[] = []
      let consumedThrough = 0
      pattern.lastIndex = 0
      for (const match of input.matchAll(pattern)) {
        consumedThrough = (match.index ?? 0) + match[0].length
        sequences.push(Number(match[1]))
      }
      suffix = input.slice(consumedThrough).slice(-maximumSuffixChars)
      return sequences
    },
  }
}
