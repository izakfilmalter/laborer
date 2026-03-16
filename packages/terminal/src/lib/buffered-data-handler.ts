/**
 * Escape sequence buffering for raw PTY output.
 *
 * Wraps a PTY onData callback to prevent incomplete VT escape sequences
 * from reaching subscribers. Holds back trailing fragments (bare ESC,
 * incomplete CSI introducer, CSI with partial parameters) until the
 * next data chunk completes them.
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #6: Backend: Escape sequence buffering
 */

/**
 * Matches a trailing incomplete CSI sequence: ESC [ followed by digits and
 * semicolons (parameter bytes) but no final command byte. Defined at module
 * level so the regex is compiled once, not per handler invocation.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC character is intentional for VT escape sequence detection
const INCOMPLETE_CSI_REGEX = /\x1b\[[0-9;]*$/

/**
 * Create a buffered data handler that holds back incomplete escape sequences.
 *
 * Returns a function with the same signature as the input callback. Data
 * is forwarded to `onData` immediately unless the chunk ends with an
 * incomplete escape sequence, in which case the trailing fragment is
 * held back and prepended to the next chunk.
 */
const createBufferedDataHandler = (
  onData: (data: string) => void
): ((data: string) => void) => {
  let buffer = ''

  return (data: string) => {
    buffer += data
    let sendUpTo = buffer.length

    // Hold back incomplete escape sequences at the end of the buffer
    if (buffer.endsWith('\x1b')) {
      sendUpTo = buffer.length - 1
    } else if (buffer.endsWith('\x1b[')) {
      sendUpTo = buffer.length - 2
    } else {
      // Check for an incomplete CSI sequence: ESC [ followed by digits/semicolons
      // but no final command byte yet (a letter like m, H, J, etc.)
      const match = INCOMPLETE_CSI_REGEX.exec(buffer)
      if (match !== null) {
        sendUpTo = buffer.length - match[0].length
      }
    }

    if (sendUpTo > 0) {
      onData(buffer.substring(0, sendUpTo))
      buffer = buffer.substring(sendUpTo)
    }
  }
}

export { createBufferedDataHandler }
