import { describe, expect, it } from 'vitest'
import { projectContainsRoot } from '../src/rpc/handlers.js'

describe('projectContainsRoot', () => {
  it('matches equal paths and directory ancestors only', () => {
    expect(projectContainsRoot('/repo', '/repo')).toBe(true)
    expect(projectContainsRoot('/repo', '/repo/packages/app')).toBe(true)
    expect(projectContainsRoot('/repo', '/repository')).toBe(false)
    expect(projectContainsRoot('/repo/packages/app', '/repo')).toBe(false)
  })
})
