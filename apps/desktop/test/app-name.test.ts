import { describe, expect, it } from 'vitest'

import { resolveDesktopAppName } from '../src/app-name.js'

describe('resolveDesktopAppName', () => {
  it('keeps the stable app name for stable packaged builds', () => {
    expect(
      resolveDesktopAppName({
        isDevelopment: false,
        version: '1.2.3',
      })
    ).toBe('Laborer')
  })

  it('adds -dev while running from the dev server', () => {
    expect(
      resolveDesktopAppName({
        isDevelopment: true,
        version: '1.2.3',
      })
    ).toBe('Laborer-dev')
  })

  it('adds -dev for packaged prerelease builds', () => {
    expect(
      resolveDesktopAppName({
        isDevelopment: false,
        version: '1.2.3-dev.1',
      })
    ).toBe('Laborer-dev')
  })
})
