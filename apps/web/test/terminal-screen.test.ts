/**
 * The surface a pane draws on has its own lifetime, independent of the attach
 * stream feeding it. These tests pin the consequences: a rebuilt surface is a
 * different screen, and output aimed at the one it replaced — or at a pane
 * whose asynchronously built surface has not arrived yet — belongs to a screen
 * the operator cannot see.
 *
 * @see apps/web/src/lib/terminal-screen.ts
 */

import { describe, expect, it } from 'vitest'

import {
  createTerminalScreen,
  type TerminalScreenCanvas,
} from '../src/lib/terminal-screen'

/** Stands in for the Ghostty surface: every write parses before it returns. */
const createCanvas = () => {
  const drawn: string[] = []
  const canvas: TerminalScreenCanvas = {
    resetAndWrite: (data) => {
      drawn.length = 0
      if (data.length > 0) {
        drawn.push(data)
      }
    },
    write: (data) => {
      drawn.push(data)
    },
  }
  return { canvas, drawn }
}

describe('terminal screen', () => {
  it('has no generation until a surface is mounted', () => {
    const screen = createTerminalScreen()

    expect(screen.generation()).toBe(0)
  })

  it('gives each mounted surface its own generation', () => {
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

  it('reports no generation once the surface is retired', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)
    screen.unmount(canvas.canvas)

    expect(screen.generation()).toBe(0)
  })

  it('lets a stale cleanup run after the surface that replaced it', () => {
    const screen = createTerminalScreen()
    const previous = createCanvas()
    const next = createCanvas()

    screen.mount(previous.canvas)
    screen.mount(next.canvas)
    // React's remount ordering can deliver the old cleanup afterwards; it must
    // not retire the surface now on screen.
    screen.unmount(previous.canvas)

    screen.write('live')

    expect(next.drawn).toEqual(['live'])
    expect(screen.generation()).not.toBe(0)
  })

  it('draws onto the mounted surface and reports that it landed', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)

    expect(screen.write('hello')).toBe(true)
    expect(canvas.drawn).toEqual(['hello'])
  })

  it('accepts an empty chunk without troubling the surface', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)

    expect(screen.write('')).toBe(true)
    expect(canvas.drawn).toEqual([])
  })

  it('replaces the screen for a snapshot rather than appending it', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)
    screen.write('history')

    expect(screen.resetAndWrite('restored')).toBe(true)
    expect(canvas.drawn).toEqual(['restored'])
  })

  it('clears the screen for an empty snapshot', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    screen.mount(canvas.canvas)
    screen.write('history')
    // A `Reset` has no payload to replay: the empty snapshot is the RIS.
    screen.resetAndWrite('')

    expect(canvas.drawn).toEqual([])
  })

  it('drops output that has no surface to land on', () => {
    const screen = createTerminalScreen()
    const canvas = createCanvas()

    // Reporting the drop is what keeps the caller from counting the chunk as
    // reached and resuming past output no screen ever showed. A pane renders
    // before Ghostty's surface finishes loading, so this is the ordinary
    // opening state of every pane, not just a teardown race.
    expect(screen.write('orphan')).toBe(false)
    expect(screen.resetAndWrite('snapshot')).toBe(false)

    // The surface that eventually mounts is blank and forces a fresh replay,
    // so the orphaned chunks must not surface on it.
    screen.mount(canvas.canvas)

    expect(canvas.drawn).toEqual([])
  })

  it('announces a rebuilt surface to whoever is feeding the screen', () => {
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

  it('announces the first surface, so a waiting attach can open', () => {
    const screen = createTerminalScreen()
    const generations: number[] = []

    screen.subscribe(() => {
      generations.push(screen.generation())
    })
    screen.mount(createCanvas().canvas)

    expect(generations).toEqual([1])
  })
})
