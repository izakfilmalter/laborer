/**
 * Unit tests for pure process detection functions:
 * - classifyProcess — maps process name to ForegroundProcess descriptor
 * - buildDetectionFromTitle — builds detection result from OSC title
 * - isIdleTitle — classifies terminal title as idle or running
 *
 * @see packages/terminal/src/services/terminal-manager.ts
 */

import { describe, expect, it } from 'vitest'
import type { ProcessDetectionResult } from '../src/services/terminal-manager.js'
import {
  buildDetectionFromTitle,
  classifyProcess,
  detectForShellPid,
  isIdleTitle,
  parsePsOutput,
} from '../src/services/terminal-manager.js'

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

  it('classifies the OpenCode 2 agent binary', () => {
    const result = classifyProcess('/usr/local/bin/OpenCode2')

    expect(result).toStrictEqual({
      category: 'agent',
      label: 'OpenCode 2',
      rawName: 'opencode2',
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

describe('process-tree walking', () => {
  it('finds an agent in any child branch', () => {
    const { childrenByPid, commByPid } = parsePsOutput(`
      1 0 zsh
      2 1 node
      3 1 vite
      4 2 claude
      5 3 esbuild
    `)

    const result = detectForShellPid(1, childrenByPid, commByPid)

    expect(result.agentProcessIds).toEqual([4])
    expect(result.processChain.map(({ rawName }) => rawName)).toEqual([
      'node',
      'vite',
      'claude',
      'esbuild',
    ])
  })

  it('checks every shallow branch before spending the process bound deeply', () => {
    const wideBranch = Array.from(
      { length: 300 },
      (_, index) => `${index + 10} 2 worker-${index}`
    ).join('\n')
    const { childrenByPid, commByPid } = parsePsOutput(`
      1 0 zsh
      2 1 node
      3 1 claude
      ${wideBranch}
    `)

    const result = detectForShellPid(1, childrenByPid, commByPid)

    expect(result.agentProcessIds).toEqual([3])
  })
})

describe('isIdleTitle', () => {
  it('returns true for empty string', () => {
    expect(isIdleTitle('')).toBe(true)
  })

  it('returns true for path starting with ~', () => {
    expect(isIdleTitle('~/projects/my-app')).toBe(true)
  })

  it('returns true for absolute path', () => {
    expect(isIdleTitle('/Users/dev/code')).toBe(true)
  })

  it('returns true for SSH prompt pattern', () => {
    expect(isIdleTitle('user@host:/tmp')).toBe(true)
  })

  it('returns true for shell names', () => {
    expect(isIdleTitle('zsh')).toBe(true)
    expect(isIdleTitle('bash')).toBe(true)
    expect(isIdleTitle('fish')).toBe(true)
  })

  it('returns false for command names', () => {
    expect(isIdleTitle('opencode')).toBe(false)
    expect(isIdleTitle('vim main.ts')).toBe(false)
    expect(isIdleTitle('npm run dev')).toBe(false)
  })
})

describe('buildDetectionFromTitle', () => {
  const snapshotWithChild: ProcessDetectionResult = {
    agentProcessIds: [],
    foregroundProcess: {
      category: 'unknown',
      label: 'sleep',
      rawName: 'sleep',
    },
    hasChildProcess: true,
    processChain: [{ category: 'unknown', label: 'sleep', rawName: 'sleep' }],
  }

  const snapshotIdle: ProcessDetectionResult = {
    agentProcessIds: [],
    foregroundProcess: null,
    hasChildProcess: false,
    processChain: [],
  }

  it('returns null when title is idle and no previous snapshot exists', () => {
    const result = buildDetectionFromTitle('~/projects/my-app', undefined)
    expect(result).toBeNull()
  })

  it('preserves hasChildProcess=true when title is idle but process is running', () => {
    const result = buildDetectionFromTitle(
      '~/projects/my-app',
      snapshotWithChild
    )
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(true)
    expect(result?.foregroundProcess).toBeNull()
  })

  it('preserves hasChildProcess=false when title is idle and no process was running', () => {
    const result = buildDetectionFromTitle('~/projects/my-app', snapshotIdle)
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(false)
  })

  it('sets hasChildProcess=true when title is a known non-shell process', () => {
    const result = buildDetectionFromTitle('opencode', undefined)
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(true)
    expect(result?.foregroundProcess?.category).toBe('agent')
    expect(result?.foregroundProcess?.label).toBe('OpenCode')
  })

  it('sets hasChildProcess=true when title is a known editor', () => {
    const result = buildDetectionFromTitle('vim', undefined)
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(true)
    expect(result?.foregroundProcess?.category).toBe('editor')
  })

  it('never downgrades hasChildProcess from true to false via title', () => {
    // Even with a shell name title, if the previous snapshot had
    // hasChildProcess=true, it must stay true.
    const result = buildDetectionFromTitle('zsh', snapshotWithChild)
    // 'zsh' is classified as idle by isIdleTitle, so we preserve snapshot
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(true)
  })

  it('handles empty title (OSC 133 idle) with previous snapshot', () => {
    const result = buildDetectionFromTitle('', snapshotWithChild)
    expect(result).not.toBeNull()
    expect(result?.hasChildProcess).toBe(true)
    expect(result?.foregroundProcess).toBeNull()
  })

  it('handles empty title without previous snapshot', () => {
    const result = buildDetectionFromTitle('', undefined)
    expect(result).toBeNull()
  })
})
