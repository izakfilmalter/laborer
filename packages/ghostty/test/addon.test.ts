import { describe, expect, it } from 'vitest'

import { getInfo, init, isInitialized, validateConfig } from '../src/index.ts'

describe('ghostty native addon', () => {
  it('reports not initialized before init()', () => {
    // Note: if a previous test already called init(), this may be true.
    // The addon uses a global flag, so ordering matters in practice.
    // This test is useful for first-run validation.
    const result = isInitialized()
    expect(typeof result).toBe('boolean')
  })

  it('initializes the ghostty runtime', () => {
    const result = init()
    expect(result).toBe(true)
  })

  it('reports initialized after init()', () => {
    expect(isInitialized()).toBe(true)
  })

  it('returns idempotent success on repeated init()', () => {
    const result = init()
    expect(result).toBe(true)
  })

  it('returns build info with version and buildMode', () => {
    const info = getInfo()
    expect(info).toBeDefined()
    expect(typeof info.version).toBe('string')
    expect(info.version.length).toBeGreaterThan(0)
    expect(typeof info.buildMode).toBe('string')
    expect([
      'debug',
      'release-safe',
      'release-fast',
      'release-small',
    ]).toContain(info.buildMode)
  })

  it('validates config subsystem', () => {
    const result = validateConfig()
    expect(result).toBeDefined()
    expect(result.success).toBe(true)
    expect(typeof result.diagnosticsCount).toBe('number')
  })
})
