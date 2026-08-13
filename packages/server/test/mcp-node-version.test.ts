import { describe, expect, it } from 'vitest'
import {
  nodeMajorVersion,
  unsupportedMcpNodeMessage,
} from '../src/mcp-node-version.js'

describe('MCP Node version guard', () => {
  it('accepts Node 24 and newer', () => {
    expect(nodeMajorVersion('v24.11.1')).toBe(24)
    expect(unsupportedMcpNodeMessage('v24.0.0')).toBeUndefined()
    expect(unsupportedMcpNodeMessage('v25.1.0')).toBeUndefined()
  })

  it('returns a legible failure for old or malformed versions', () => {
    expect(unsupportedMcpNodeMessage('v23.9.0')).toBe(
      'Laborer MCP requires Node.js 24 or newer (running v23.9.0).'
    )
    expect(unsupportedMcpNodeMessage('unknown')).toContain(
      'requires Node.js 24 or newer'
    )
  })
})
