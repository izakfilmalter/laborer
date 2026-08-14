import type { TerminalAttachEvent } from '@laborer/shared/rpc'

const encoder = new TextEncoder()

/** Named build-time defaults. Environment overrides are parsed by TerminalManager. */
export const TERMINAL_REPLAY_JOURNAL_BYTES_DEFAULT = 256 * 1024
export const TERMINAL_OUTPUT_CHUNK_BYTES_DEFAULT = 16 * 1024
export const TERMINAL_SNAPSHOT_BYTES_DEFAULT = 512 * 1024
export const TERMINAL_INPUT_WRITE_BYTES_DEFAULT = 64 * 1024
export const TERMINAL_INPUT_PENDING_BYTES_DEFAULT = 64 * 1024
export const TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT = 64
export const TERMINAL_ACK_BATCH_CHARS_DEFAULT = 5000

export const utf8Bytes = (value: string): number => encoder.encode(value).length

export const positiveIntegerFromEnv = (
  name: string,
  fallback: number
): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const parsed = Number(raw)
  if (!(Number.isSafeInteger(parsed) && parsed > 0)) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return parsed
}

/** Split on Unicode code-point boundaries while enforcing an encoded-byte cap. */
export const splitByUtf8Bytes = (
  data: string,
  maximumBytes: number
): string[] => {
  if (data.length === 0) {
    return []
  }
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const codePoint of data) {
    const size = utf8Bytes(codePoint)
    if (size > maximumBytes) {
      throw new Error(
        'Terminal output chunk byte cap is smaller than one code point'
      )
    }
    if (bytes + size > maximumBytes && chunk.length > 0) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += codePoint
    bytes += size
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}

interface JournalEntry {
  readonly bytes: number
  readonly chars: number
  readonly data: string
  readonly end: number
  readonly start: number
}

/** Exact UTF-8 byte cursor ring. Entries are already capped wire chunks. */
export class TerminalCursorJournal {
  readonly #entries: JournalEntry[] = []
  readonly #maximumBytes: number
  #bytes = 0
  #cursor = 0

  constructor(maximumBytes = TERMINAL_REPLAY_JOURNAL_BYTES_DEFAULT) {
    if (!(Number.isSafeInteger(maximumBytes) && maximumBytes > 0)) {
      throw new Error('Terminal journal byte bound must be positive')
    }
    this.#maximumBytes = maximumBytes
  }

  get bytes(): number {
    return this.#bytes
  }
  get cursor(): number {
    return this.#cursor
  }
  get minimumCursor(): number {
    return this.#entries[0]?.start ?? this.#cursor
  }

  append(data: string): number {
    const bytes = utf8Bytes(data)
    if (bytes > this.#maximumBytes) {
      throw new Error('Terminal journal entry exceeds journal byte bound')
    }
    const start = this.#cursor
    this.#cursor += bytes
    this.#entries.push({
      data,
      start,
      end: this.#cursor,
      bytes,
      chars: data.length,
    })
    this.#bytes += bytes
    while (this.#bytes > this.#maximumBytes) {
      const removed = this.#entries.shift()
      if (removed) {
        this.#bytes -= removed.bytes
      }
    }
    return this.#cursor
  }

  retains(cursor: number): boolean {
    return (
      Number.isSafeInteger(cursor) &&
      cursor >= this.minimumCursor &&
      cursor <= this.#cursor
    )
  }

  deltasAfter(cursor: number): TerminalAttachEvent[] {
    if (!this.retains(cursor)) {
      return []
    }
    return this.#entries
      .filter((entry) => entry.end > cursor)
      .map((entry) => ({
        _tag: 'Delta' as const,
        cursor: entry.end,
        data: entry.data,
      }))
  }

  charactersBetween(start: number, end: number): number {
    if (!(this.retains(start) && this.retains(end) && end >= start)) {
      return 0
    }
    return this.#entries
      .filter((entry) => entry.end > start && entry.end <= end)
      .reduce((total, entry) => total + entry.chars, 0)
  }
}
