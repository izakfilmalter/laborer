import { describe, expect, it } from 'vitest'

import {
  buildWindowBootstrapArgs,
  createWindowId,
  parseWindowBootstrapArgs,
} from '../src/window-identity.js'

describe('createWindowId', () => {
  it('creates distinct stable ids for separate windows', () => {
    const firstWindowId = createWindowId()
    const secondWindowId = createWindowId()

    expect(firstWindowId).toHaveLength(36)
    expect(secondWindowId).toHaveLength(36)
    expect(secondWindowId).not.toBe(firstWindowId)
  })
})

describe('window bootstrap args', () => {
  it('associates preload args with the correct renderer window id', () => {
    const bootstrapArgs = buildWindowBootstrapArgs({
      windowId: 'window-alpha',
    })

    expect(parseWindowBootstrapArgs(bootstrapArgs)).toEqual({
      windowId: 'window-alpha',
    })
  })

  it('falls back to empty values when bootstrap args are missing', () => {
    expect(parseWindowBootstrapArgs([])).toEqual({
      windowId: '',
    })
  })
})
