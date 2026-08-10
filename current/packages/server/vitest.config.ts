import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
    },
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/isolate-state-home.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Retry FS-watcher integration tests that depend on macOS
    // FSEvents delivering events reliably. Some tests involving
    // multiple concurrent @parcel/watcher subscriptions may fail
    // intermittently due to FSEvents batching and timing.
    retry: 3,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Run tests sequentially to avoid macOS FSEvents dropping
        // events when multiple @parcel/watcher subscriptions from
        // concurrent test files compete for filesystem notifications.
        maxForks: 1,
      },
    },
    server: {
      deps: {
        inline: ['@effect/vitest'],
      },
    },
  },
})
