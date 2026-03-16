/**
 * Unit tests for classifyProcess — the pure function that maps a process
 * name (from `ps -o comm=`) to a ForegroundProcess descriptor with
 * category, label, and rawName.
 *
 * @see packages/terminal/src/services/terminal-manager.ts — classifyProcess
 */

import { describe, expect, it } from 'vitest'
import { classifyProcess } from '../src/services/terminal-manager.js'

describe('classifyProcess', () => {
  it('classifies a known agent process with correct label and category', () => {
    const result = classifyProcess('opencode')

    expect(result).toStrictEqual({
      category: 'agent',
      label: 'OpenCode',
      rawName: 'opencode',
    })
  })

  it('classifies a mixed-case agent binary as the known agent', () => {
    const result = classifyProcess('OpenCode')

    expect(result).toStrictEqual({
      category: 'agent',
      label: 'OpenCode',
      rawName: 'opencode',
    })
  })

  it('classifies an uppercase agent binary as the known agent', () => {
    const result = classifyProcess('CLAUDE')

    expect(result).toStrictEqual({
      category: 'agent',
      label: 'Claude',
      rawName: 'claude',
    })
  })

  it('extracts basename from a full path before classifying', () => {
    const result = classifyProcess('/usr/local/bin/OpenCode')

    expect(result).toStrictEqual({
      category: 'agent',
      label: 'OpenCode',
      rawName: 'opencode',
    })
  })

  it('returns null for an empty process name', () => {
    expect(classifyProcess('')).toBeNull()
  })

  it('returns unknown category with lowercase rawName for unrecognized processes', () => {
    const result = classifyProcess('MyCustomTool')

    expect(result).toStrictEqual({
      category: 'unknown',
      label: 'MyCustomTool',
      rawName: 'mycustomtool',
    })
  })
})
