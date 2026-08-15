import { describe, expect, it } from 'vitest'

import {
  DEV_TERMINAL_XDG_STATE_HOME,
  terminalSpawnEnvironment,
} from '../src/services/terminal-spawn-environment.js'

describe('terminal spawn environment', () => {
  it('uses the user state home instead of Laborer dev isolation', () => {
    expect(
      terminalSpawnEnvironment(
        {
          [DEV_TERMINAL_XDG_STATE_HOME]: '/Users/me/.local/state',
          HOME: '/Users/me',
          XDG_STATE_HOME: '/repo/.laborer-state',
        },
        {},
        {}
      ).XDG_STATE_HOME
    ).toBe('/Users/me/.local/state')
  })

  it('supports a daemon started before the dev runner provided the marker', () => {
    expect(
      terminalSpawnEnvironment(
        {
          HOME: '/Users/me',
          LABORER_DEV_WATCH: '1',
          XDG_STATE_HOME: '/repo/.laborer-state',
        },
        {},
        {}
      ).XDG_STATE_HOME
    ).toBe('/Users/me/.local/state')
  })

  it('preserves production state without the dev marker', () => {
    expect(
      terminalSpawnEnvironment({ XDG_STATE_HOME: '/custom/state' }, {}, {})
        .XDG_STATE_HOME
    ).toBe('/custom/state')
  })

  it('allows an explicit workspace state home to win', () => {
    expect(
      terminalSpawnEnvironment(
        {
          [DEV_TERMINAL_XDG_STATE_HOME]: '/Users/me/.local/state',
          XDG_STATE_HOME: '/repo/.laborer-state',
        },
        { XDG_STATE_HOME: '/workspace/state' },
        {}
      ).XDG_STATE_HOME
    ).toBe('/workspace/state')
  })
})
