/**
 * The canvas a pane draws on has its own lifetime, independent of the attach
 * stream feeding it. These tests pin the consequences: a rebuilt canvas is a
 * different screen, and everything queued for the one it replaced — output and
 * the parse callbacks that acknowledge it — belongs to a screen the operator
 * can no longer see.
 *
 * @see apps/web/src/lib/terminal-screen.ts
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createTerminalScreen,
  type TerminalScreenCanvas,
} from '../src/lib/terminal-screen'

/** Stands in for xterm: chunks are parsed when the test says so. */
const createCanvas = () => {
  const drawn: string[] = []
  const parsers: Array<() => void> = []
  const canvas: TerminalScreenCanvas = {
    reset: () => {
      drawn.length = 0
    },
    write: (data, commit) => {
      drawn.push(data)
      parsers.push(commit)
    },
  }
  return {
    canvas,
    drawn,
    parseNext: () => {
      const parse = parsers.shift()
      if (!parse) {
        throw new Error('No queued write to parse')
      }
      parse()
    },
    pending: () => parsers.length,
  }
}

describe('terminal screen', () => {
  it('has no generation until a canvas is mounted', () => {
    const screen = createTerminalScreen()

    expect(screen.generation()).toBe(0)
  })

  it('gives each mounted canvas its own generation', () => {
    const screen = createTerminalScreen()
    const first = createCanvas()
    const second = createCanvas()

    screen.mount(first.canvas)
    const firstGeneration = screen.generation()
    screen.unmount(first.canvas)
    screen.mount(second.canvas)

    expect(firstGeneration).not.toBe(0)
    expect(screen.generation()).not.toBe(firstGeneration)
  })

  it('reports no generation once the canvas is retired', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)
    screen.unmount(canvas.canvas)

    expect(screen.generation()).toBe(0)
  })

  it('lets a stale cleanup run after the canvas that replaced it', () => {
    const screen = createTerminalScreen()
    const previous = createCanvas()
    const next = createCanvas()

    screen.mount(previous.canvas)
    screen.mount(next.canvas)
    // React's remount ordering can deliver the old cleanup afterwards; it must
    // not retire the canvas now on screen.
    screen.unmount(previous.canvas)

    const commit = vi.fn()
    screen.write('live', commit)

    expect(next.drawn).toEqual(['live'])
    expect(screen.generation()).not.toBe(0)
  })

  it('draws onto the mounted canvas and commits when it parses', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()
    const commit = vi.fn()

    screen.mount(canvas.canvas)

    expect(screen.write('hello', commit)).toBe(true)
    expect(canvas.drawn).toEqual(['hello'])
    expect(commit).not.toHaveBeenCalled()

    canvas.parseNext()
    expect(commit).toHaveBeenCalledOnce()
  })

  it('commits an empty chunk without troubling the canvas', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()
    const commit = vi.fn()

    screen.mount(canvas.canvas)
    screen.write('', commit)

    expect(canvas.drawn).toEqual([])
    expect(commit).toHaveBeenCalledOnce()
  })

  it('drops output that has no canvas to land on', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()
    const commit = vi.fn()

    // Reporting the drop is what keeps the caller from counting the chunk as
    // reached and resuming past output no screen ever showed.
    expect(screen.write('orphan', commit)).toBe(false)
    // The canvas that eventually mounts is blank and forces a fresh replay, so
    // the orphaned chunk must not surface on it or be acknowledged.
    screen.mount(canvas.canvas)

    expect(canvas.drawn).toEqual([])
    expect(canvas.pending()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })

  it('never lets a retired canvas parse its way into an acknowledgement', () => {
    const screen = createTerminalScreen()
    const previous = createCanvas()
    const next = createCanvas()
    const commit = vi.fn()

    screen.mount(previous.canvas)
    screen.write('history', commit)
    screen.unmount(previous.canvas)
    screen.mount(next.canvas)

    // xterm can report the chunk parsed after its terminal was replaced.
    previous.parseNext()

    expect(commit).not.toHaveBeenCalled()
    expect(next.drawn).toEqual([])
  })

  it('clears only the canvas on screen', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)
    screen.write('history', () => undefined)
    screen.reset()

    expect(canvas.drawn).toEqual([])

    screen.unmount(canvas.canvas)
    // A pane with no canvas has nothing to clear, and must not throw for it.
    expect(() => {
      screen.reset()
    }).not.toThrow()
  })

  it('announces a rebuilt canvas to whoever is feeding the screen', () => {
    const screen = createTerminalScreen()
    const first = createCanvas()
    const second = createCanvas()
    const generations: number[] = []

    screen.mount(first.canvas)
    const unsubscribe = screen.subscribe(() => {
      generations.push(screen.generation())
    })
    const attached = screen.generation()

    screen.unmount(first.canvas)
    screen.mount(second.canvas)

    expect(generations).toEqual([screen.generation()])
    expect(screen.generation()).not.toBe(attached)

    unsubscribe()
    screen.mount(createCanvas().canvas)
    expect(generations).toHaveLength(1)
  })
})
