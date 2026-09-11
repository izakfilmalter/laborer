import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['diagnostics/**/*.test.ts'],
  },
})
