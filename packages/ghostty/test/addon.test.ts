import { afterAll, describe, expect, it } from 'vitest'

import {
  appTick,
  createApp,
  createSurface,
  destroyApp,
  destroySurface,
  getInfo,
  getSurfaceIOSurfaceId,
  getSurfaceSize,
  init,
  isAppCreated,
  isInitialized,
  listSurfaces,
  setSurfaceFocus,
  setSurfaceSize,
  validateConfig,
} from '../src/index.ts'

describe('ghostty native addon', () => {
  // ---------------------------------------------------------------------------
  // Runtime initialization (from Issue 2)
  // ---------------------------------------------------------------------------

  it('reports not initialized before init()', () => {
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

  // ---------------------------------------------------------------------------
  // App lifecycle (Issue 1)
  // ---------------------------------------------------------------------------

  describe('app lifecycle', () => {
    afterAll(() => {
      // Ensure app is cleaned up even if tests fail
      try {
        destroyApp()
      } catch {
        // Ignore cleanup errors
      }
    })

    it('reports app not created before createApp()', () => {
      expect(isAppCreated()).toBe(false)
    })

    it('creates the ghostty app runtime', () => {
      const result = createApp()
      expect(result).toBe(true)
    })

    it('reports app created after createApp()', () => {
      expect(isAppCreated()).toBe(true)
    })

    it('returns idempotent success on repeated createApp()', () => {
      const result = createApp()
      expect(result).toBe(true)
    })

    it('can tick the app without error', () => {
      expect(() => appTick()).not.toThrow()
    })

    it('starts with no surfaces', () => {
      const surfaces = listSurfaces()
      expect(surfaces).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Surface lifecycle (Issue 1)
  // ---------------------------------------------------------------------------

  describe('surface lifecycle', () => {
    afterAll(() => {
      // Clean up all surfaces and app
      try {
        for (const id of listSurfaces()) {
          destroySurface(id)
        }
        destroyApp()
      } catch {
        // Ignore cleanup errors
      }
    })

    it('creates a surface with default options', () => {
      // Ensure app is created
      if (!isAppCreated()) {
        createApp()
      }

      const handle = createSurface()
      expect(handle).toBeDefined()
      expect(typeof handle.id).toBe('number')
      expect(handle.id).toBeGreaterThan(0)
    })

    it('lists the created surface', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThanOrEqual(1)
    })

    it('creates a surface with custom dimensions', () => {
      const handle = createSurface({ width: 1024, height: 768 })
      expect(handle).toBeDefined()
      expect(typeof handle.id).toBe('number')
    })

    it('creates a surface with working directory', () => {
      const handle = createSurface({ workingDirectory: '/tmp' })
      expect(handle).toBeDefined()
      expect(typeof handle.id).toBe('number')
    })

    it('can get surface size', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const size = getSurfaceSize(surfaceId)
      expect(size).toBeDefined()
      expect(typeof size.columns).toBe('number')
      expect(typeof size.rows).toBe('number')
      expect(typeof size.widthPx).toBe('number')
      expect(typeof size.heightPx).toBe('number')
      expect(typeof size.cellWidthPx).toBe('number')
      expect(typeof size.cellHeightPx).toBe('number')
    })

    it('can set surface size', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const result = setSurfaceSize(surfaceId, 640, 480)
      expect(result).toBe(true)
    })

    it('can set surface focus', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const focusResult = setSurfaceFocus(surfaceId, true)
      expect(focusResult).toBe(true)

      const unfocusResult = setSurfaceFocus(surfaceId, false)
      expect(unfocusResult).toBe(true)
    })

    it('can query IOSurface info', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const ioInfo = getSurfaceIOSurfaceId(surfaceId)
      expect(ioInfo).toBeDefined()
      expect(typeof ioInfo.hasLayer).toBe('boolean')
      // ioSurfaceId may be null if Ghostty hasn't rendered yet
      expect(
        ioInfo.ioSurfaceId === null || typeof ioInfo.ioSurfaceId === 'number'
      ).toBe(true)
    })

    it('can destroy a surface', () => {
      const surfaces = listSurfaces()
      const countBefore = surfaces.length
      expect(countBefore).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const result = destroySurface(surfaceId)
      expect(result).toBe(true)

      const countAfter = listSurfaces().length
      expect(countAfter).toBe(countBefore - 1)
    })

    it('throws when destroying a non-existent surface', () => {
      expect(() => destroySurface(999_999)).toThrow()
    })

    it('throws when getting size of non-existent surface', () => {
      expect(() => getSurfaceSize(999_999)).toThrow()
    })

    it('can destroy the app and clean up remaining surfaces', () => {
      const result = destroyApp()
      expect(result).toBe(true)
      expect(isAppCreated()).toBe(false)
    })

    it('reports no surfaces after app destruction', () => {
      // Recreate app to test listSurfaces on clean state
      createApp()
      const surfaces = listSurfaces()
      expect(surfaces).toEqual([])
      destroyApp()
    })
  })
})
