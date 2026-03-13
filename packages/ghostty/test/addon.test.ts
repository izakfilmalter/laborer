import { afterAll, describe, expect, it } from 'vitest'

import {
  appTick,
  createApp,
  createSurface,
  destroyApp,
  destroySurface,
  drainActions,
  getConfigDiagnostics,
  getConfigPath,
  getInfo,
  getSurfaceIOSurfaceHandle,
  getSurfaceIOSurfaceId,
  getSurfacePixels,
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
  // Config (Issue 9)
  // ---------------------------------------------------------------------------

  describe('config', () => {
    it('returns a config path', () => {
      const configPath = getConfigPath()
      // configPath should be a string path or null
      expect(configPath === null || typeof configPath === 'string').toBe(true)
      if (configPath !== null) {
        // Should contain a recognizable path component
        expect(configPath.length).toBeGreaterThan(0)
        expect(configPath).toContain('ghostty')
      }
    })

    it('returns empty config diagnostics before app creation', () => {
      const diag = getConfigDiagnostics()
      expect(diag).toBeDefined()
      expect(diag.diagnosticsCount).toBe(0)
      expect(Array.isArray(diag.diagnostics)).toBe(true)
      expect(diag.diagnostics.length).toBe(0)
    })
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

    it('creates the ghostty app runtime with config loading', () => {
      const result = createApp()
      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(typeof result.diagnosticsCount).toBe('number')
      expect(Array.isArray(result.diagnostics)).toBe(true)
    })

    it('reports app created after createApp()', () => {
      expect(isAppCreated()).toBe(true)
    })

    it('returns idempotent success on repeated createApp()', () => {
      const result = createApp()
      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    it('returns config diagnostics after app creation', () => {
      const diag = getConfigDiagnostics()
      expect(diag).toBeDefined()
      expect(typeof diag.diagnosticsCount).toBe('number')
      expect(Array.isArray(diag.diagnostics)).toBe(true)
      // diagnosticsCount and diagnostics array should match
      expect(diag.diagnostics.length).toBe(diag.diagnosticsCount)
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

    it('can read surface pixels or returns null when no frame rendered', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const pixels = getSurfacePixels(surfaceId)
      // May be null if Ghostty hasn't rendered yet, or a SurfacePixels object
      if (pixels !== null) {
        expect(typeof pixels.width).toBe('number')
        expect(typeof pixels.height).toBe('number')
        expect(pixels.width).toBeGreaterThan(0)
        expect(pixels.height).toBeGreaterThan(0)
        expect(Buffer.isBuffer(pixels.data)).toBe(true)
        expect(pixels.data.length).toBe(pixels.width * pixels.height * 4)
      }
    })

    it('returns pixel data after ticking to allow rendering', async () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      // Tick several times to give Ghostty a chance to render
      for (let i = 0; i < 30; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const pixels = getSurfacePixels(surfaceId)
      // After ticking, we expect pixel data to be available
      // (though in CI without a GPU, it may still be null)
      if (pixels !== null) {
        expect(pixels.width).toBeGreaterThan(0)
        expect(pixels.height).toBeGreaterThan(0)
        expect(pixels.data.length).toBe(pixels.width * pixels.height * 4)
        // Verify the buffer contains some non-zero data (not all black)
        const hasContent = pixels.data.some((byte: number) => byte !== 0)
        expect(hasContent).toBe(true)
      }
    })

    it('can query IOSurface handle or returns null when no frame rendered', () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      const handle = getSurfaceIOSurfaceHandle(surfaceId)
      // May be null if Ghostty hasn't rendered yet, or an IOSurfaceHandle
      if (handle !== null) {
        expect(typeof handle.width).toBe('number')
        expect(typeof handle.height).toBe('number')
        expect(handle.width).toBeGreaterThan(0)
        expect(handle.height).toBeGreaterThan(0)
        expect(Buffer.isBuffer(handle.ioSurfaceHandle)).toBe(true)
        // Buffer should contain a pointer (8 bytes on 64-bit)
        expect(handle.ioSurfaceHandle.length).toBe(8)
      }
    })

    it('returns IOSurface handle after ticking to allow rendering', async () => {
      const surfaces = listSurfaces()
      expect(surfaces.length).toBeGreaterThan(0)
      const surfaceId = surfaces[0] as number

      // Tick to give Ghostty time to render
      for (let i = 0; i < 30; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const handle = getSurfaceIOSurfaceHandle(surfaceId)
      // After ticking, we expect handle to be available
      // (though in CI without a GPU, it may still be null)
      if (handle !== null) {
        expect(handle.width).toBeGreaterThan(0)
        expect(handle.height).toBeGreaterThan(0)
        expect(Buffer.isBuffer(handle.ioSurfaceHandle)).toBe(true)
        expect(handle.ioSurfaceHandle.length).toBe(8)
      }
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

  // ---------------------------------------------------------------------------
  // Action queue (Issue 7)
  // ---------------------------------------------------------------------------

  describe('action queue', () => {
    afterAll(() => {
      try {
        for (const id of listSurfaces()) {
          destroySurface(id)
        }
        destroyApp()
      } catch {
        // Ignore cleanup errors
      }
    })

    it('drainActions returns an empty array when no actions are queued', () => {
      if (!isAppCreated()) {
        createApp()
      }
      // Flush any stale actions from previous test suites
      drainActions()
      // Now the queue should be empty
      const actions = drainActions()
      expect(Array.isArray(actions)).toBe(true)
      expect(actions.length).toBe(0)
    })

    it('drainActions returns actions with correct shape', async () => {
      if (!isAppCreated()) {
        createApp()
      }

      // Create a surface and tick to trigger initial actions (e.g., cell_size)
      const handle = createSurface()

      // Tick several times to trigger Ghostty runtime callbacks
      for (let i = 0; i < 10; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const actions = drainActions()
      // After creating a surface and ticking, we expect some actions
      // (at minimum cell_size and possibly set_title/pwd)
      for (const action of actions) {
        expect(typeof action.action).toBe('string')
        expect(typeof action.surfaceId).toBe('number')
        expect(typeof action.value).toBe('string')
        expect(typeof action.num1).toBe('number')
        expect(typeof action.num2).toBe('number')
      }

      destroySurface(handle.id)
    })

    it('drainActions clears the queue after draining', async () => {
      if (!isAppCreated()) {
        createApp()
      }

      const handle = createSurface()

      // Tick to generate actions
      for (let i = 0; i < 5; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // First drain may return actions
      drainActions()

      // Second drain immediately after should return empty
      const secondDrain = drainActions()
      expect(secondDrain.length).toBe(0)

      destroySurface(handle.id)
    })

    it('queued actions have valid action type strings', async () => {
      if (!isAppCreated()) {
        createApp()
      }

      const handle = createSurface()

      for (let i = 0; i < 10; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const actions = drainActions()
      const supportedTypes = new Set([
        'set_title',
        'pwd',
        'ring_bell',
        'child_exited',
        'close_window',
        'cell_size',
        'render_frame',
        'renderer_health',
      ])

      for (const action of actions) {
        // Action is either a supported type or an unsupported:* prefixed type
        const isSupported = supportedTypes.has(action.action)
        const isUnsupported = action.action.startsWith('unsupported:')
        expect(isSupported || isUnsupported).toBe(true)
      }

      destroySurface(handle.id)
      destroyApp()
    })

    it('emits render_frame actions after ticking with an active surface', async () => {
      if (!isAppCreated()) {
        createApp()
      }

      // Flush stale actions
      drainActions()

      const handle = createSurface({ width: 400, height: 300 })

      // Tick enough times to trigger at least one render
      for (let i = 0; i < 30; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const actions = drainActions()
      const renderFrameActions = actions.filter(
        (a) => a.action === 'render_frame'
      )

      // After ticking with a surface, we expect render_frame actions
      // (in CI without a GPU, rendering may not produce frames)
      if (renderFrameActions.length > 0) {
        // Verify render_frame actions have correct shape
        for (const rf of renderFrameActions) {
          expect(rf.action).toBe('render_frame')
          expect(typeof rf.surfaceId).toBe('number')
        }
        // Verify multiple render frames (subsequent frames, not just one)
        expect(renderFrameActions.length).toBeGreaterThan(1)
      } else {
        console.warn(
          '[render_frame test] No render_frame actions — likely headless/no GPU environment'
        )
      }

      destroySurface(handle.id)
      destroyApp()
    })
  })

  // ---------------------------------------------------------------------------
  // Multi-surface concurrent operations (Issue 10)
  // ---------------------------------------------------------------------------

  describe('multi-surface operations', () => {
    afterAll(() => {
      try {
        for (const id of listSurfaces()) {
          destroySurface(id)
        }
        destroyApp()
      } catch {
        // Ignore cleanup errors
      }
    })

    it('can create and operate multiple surfaces concurrently', () => {
      if (!isAppCreated()) {
        createApp()
      }

      // Create 4 surfaces simultaneously
      const surfaces = [
        createSurface({ width: 400, height: 300 }),
        createSurface({ width: 600, height: 400 }),
        createSurface({ width: 800, height: 600 }),
        createSurface({ width: 1024, height: 768 }),
      ]

      // All surfaces should have unique IDs
      const ids = surfaces.map((s) => s.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(4)

      // All should be listed
      const listed = listSurfaces()
      expect(listed.length).toBeGreaterThanOrEqual(4)
      for (const s of surfaces) {
        expect(listed).toContain(s.id)
      }

      // Operate on each surface independently
      for (const s of surfaces) {
        expect(setSurfaceSize(s.id, 500, 400)).toBe(true)
        expect(setSurfaceFocus(s.id, true)).toBe(true)
        const size = getSurfaceSize(s.id)
        expect(typeof size.columns).toBe('number')
        expect(typeof size.rows).toBe('number')
      }

      // Only one should have focus (the last one focused)
      // But all should still be operable
      for (const s of surfaces) {
        expect(setSurfaceFocus(s.id, false)).toBe(true)
      }

      // Destroy all
      for (const s of surfaces) {
        expect(destroySurface(s.id)).toBe(true)
      }
      expect(listSurfaces().length).toBe(0)
    })

    it('operations on one surface do not affect another', () => {
      if (!isAppCreated()) {
        createApp()
      }

      const surfaceA = createSurface({ width: 400, height: 300 })
      const surfaceB = createSurface({ width: 800, height: 600 })

      // Resize surface A
      setSurfaceSize(surfaceA.id, 1024, 768)

      // Surface B size should be independent
      const sizeB = getSurfaceSize(surfaceB.id)
      expect(typeof sizeB.widthPx).toBe('number')
      expect(typeof sizeB.heightPx).toBe('number')

      // Focus surface A
      setSurfaceFocus(surfaceA.id, true)
      setSurfaceFocus(surfaceB.id, false)

      // Both surfaces should still accept operations
      expect(setSurfaceSize(surfaceB.id, 640, 480)).toBe(true)
      expect(setSurfaceSize(surfaceA.id, 320, 240)).toBe(true)

      // Destroy surface A — surface B should still work
      destroySurface(surfaceA.id)
      expect(setSurfaceSize(surfaceB.id, 500, 400)).toBe(true)
      expect(setSurfaceFocus(surfaceB.id, true)).toBe(true)

      const remainingSurfaces = listSurfaces()
      expect(remainingSurfaces).toContain(surfaceB.id)
      expect(remainingSurfaces).not.toContain(surfaceA.id)

      destroySurface(surfaceB.id)
    })

    it('error on one surface does not affect others', () => {
      if (!isAppCreated()) {
        createApp()
      }

      const goodSurface = createSurface()

      // Try to operate on a non-existent surface
      expect(() => setSurfaceSize(999_999, 100, 100)).toThrow()
      expect(() => setSurfaceFocus(999_999, true)).toThrow()
      expect(() => destroySurface(999_999)).toThrow()

      // The good surface should still be fully operable
      expect(setSurfaceSize(goodSurface.id, 500, 400)).toBe(true)
      expect(setSurfaceFocus(goodSurface.id, true)).toBe(true)
      const size = getSurfaceSize(goodSurface.id)
      expect(typeof size.columns).toBe('number')

      destroySurface(goodSurface.id)
    })

    it('actions from multiple surfaces have correct surface IDs', async () => {
      if (!isAppCreated()) {
        createApp()
      }

      // Flush stale actions
      drainActions()

      const surfaceA = createSurface({ width: 400, height: 300 })
      const surfaceB = createSurface({ width: 600, height: 400 })

      // Tick to generate actions from both surfaces
      for (let i = 0; i < 15; i++) {
        appTick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const actions = drainActions()

      // Actions should reference either surface A, B, or 0 (early init)
      for (const action of actions) {
        expect(
          action.surfaceId === surfaceA.id ||
            action.surfaceId === surfaceB.id ||
            action.surfaceId === 0
        ).toBe(true)
      }

      destroySurface(surfaceA.id)
      destroySurface(surfaceB.id)
    })

    it('rapid create and destroy cycle does not leak resources', () => {
      if (!isAppCreated()) {
        createApp()
      }

      const initialSurfaceCount = listSurfaces().length

      // Create and destroy 10 surfaces in rapid succession
      for (let i = 0; i < 10; i++) {
        const s = createSurface()
        destroySurface(s.id)
      }

      // Surface count should be back to initial
      expect(listSurfaces().length).toBe(initialSurfaceCount)
    })

    it('can create surfaces after destroying all existing ones', () => {
      if (!isAppCreated()) {
        createApp()
      }

      // Create and destroy several surfaces
      const batch1 = [createSurface(), createSurface(), createSurface()]
      for (const s of batch1) {
        destroySurface(s.id)
      }

      // Create a new batch — IDs should be unique (monotonic, never reused)
      const batch2 = [createSurface(), createSurface()]
      for (const s of batch2) {
        // IDs should be higher than batch1 IDs (monotonic)
        for (const old of batch1) {
          expect(s.id).toBeGreaterThan(old.id)
        }
      }

      for (const s of batch2) {
        destroySurface(s.id)
      }

      destroyApp()
    })
  })
})
