import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/terminal/ghostty/vendor/ghostty-vt.wasm?url', async () => ({
  default: (
    await import('../src/terminal/ghostty/vendor/ghostty-vt.wasm?inline')
  ).default,
}))
vi.mock(
  '../src/terminal/ghostty/vendor/ghostty-write-pty.wasm?url&no-inline',
  async () => ({
    default: (
      await import(
        '../src/terminal/ghostty/vendor/ghostty-write-pty.wasm?inline'
      )
    ).default,
  })
)

import { GhosttyTerminalCore } from '../src/terminal/ghostty/core'

const cores = new Set<GhosttyTerminalCore>()

async function createCore(replies: string[] = []) {
  const core = await GhosttyTerminalCore.create(
    80,
    24,
    8,
    16,
    {
      foreground: { r: 229, g: 231, b: 235 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    (data) => replies.push(data)
  )
  cores.add(core)
  return core
}

function viewportText(core: GhosttyTerminalCore): string {
  return core
    .snapshot()
    .rowData.map((row) => row.text)
    .join('\n')
}

afterEach(() => {
  for (const core of cores) {
    core.dispose()
  }
  cores.clear()
})

describe('Ghostty TUI protocols', () => {
  it('parses fragmented synchronized frames while leaving paint suppression to the embedder', async () => {
    const replies: string[] = []
    const core = await createCore(replies)

    core.write('primary shell')
    core.write('\x1b[?1049h\x1b[Hprevious complete TUI frame')
    const previousFrame = viewportText(core)
    expect(previousFrame).toContain('previous complete TUI frame')

    core.write('\x1b[?2026$p')
    expect(replies.splice(0)).toEqual(['\x1b[?2026;2$y'])

    // Exercise PTY/WebSocket fragmentation across both the begin sequence and
    // frame body. A renderer honoring DEC 2026 must keep previousFrame visible.
    core.write('\x1b[?20')
    core.write('26h')
    core.write('\x1b[2J\x1b[Hpartial heading')
    const firstPartialSnapshot = viewportText(core)
    core.write('\x1b[2;1Hbody fragment')
    const secondPartialSnapshot = viewportText(core)

    core.write('\x1b[?2026$p')
    expect(replies.splice(0)).toEqual(['\x1b[?2026;1$y'])

    core.write('\x1b[3;1HTUI_FRAME_COMPLETE')
    core.write('\x1b[?202')
    core.write('6l')
    const completedFrame = viewportText(core)
    expect(completedFrame).toContain('partial heading')
    expect(completedFrame).toContain('body fragment')
    expect(completedFrame).toContain('TUI_FRAME_COMPLETE')

    core.write('\x1b[?2026$p')
    expect(replies.splice(0)).toEqual(['\x1b[?2026;2$y'])

    // snapshot() exposes parser state, not native Ghostty's renderer gate.
    // An embedder that paints each snapshot will expose these partial frames.
    expect(firstPartialSnapshot).not.toBe(previousFrame)
    expect(firstPartialSnapshot).toContain('partial heading')
    expect(secondPartialSnapshot).toContain('body fragment')
  })

  it('negotiates Kitty keyboard input while the alternate screen is active', async () => {
    const core = await createCore()
    core.write('\x1b[?1049h\x1b[>1u')

    const encoded = core.encodeKey(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
      })
    )

    expect(encoded).toBe('\x1b[99;5u')
  })

  it('requires the embedder to provide the synchronized-output timeout', async () => {
    const replies: string[] = []
    const core = await createCore(replies)
    core.write('\x1b[?2026h')

    await new Promise((resolve) => setTimeout(resolve, 1100))
    core.write('\x1b[?2026$p')
    expect(replies.splice(0)).toEqual(['\x1b[?2026;1$y'])

    // libghostty-vt documents resize as a spec-permitted escape hatch. The
    // native Ghostty app separately owns a one-second termio timer, but that
    // thread/timer is not part of this WASM ABI.
    core.resize(80, 24, 8, 16)
    core.write('\x1b[?2026$p')
    expect(replies.splice(0)).toEqual(['\x1b[?2026;2$y'])
  })
})
