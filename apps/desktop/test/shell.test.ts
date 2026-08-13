/**
 * Unit tests for shell environment probing.
 *
 * Tests cover:
 * - extractPathFromShellOutput: parsing PATH from sentinel-delimited output
 * - readPathFromLoginShell: invoking the shell and extracting PATH
 *
 * All tests use mock shell output — no actual shell is spawned.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  extractPathFromShellOutput,
  readPathFromLoginShell,
} from '../src/shell.js'

describe('extractPathFromShellOutput', () => {
  it('extracts the PATH between capture markers', () => {
    const output =
      '__LABORER_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__LABORER_PATH_END__\n'
    expect(extractPathFromShellOutput(output)).toBe(
      '/opt/homebrew/bin:/usr/bin'
    )
  })

  it('ignores shell startup noise around the capture markers', () => {
    const output =
      'Welcome to fish, the friendly interactive shell\n' +
      'Type help for instructions on how to use fish\n' +
      '__LABORER_PATH_START__\n' +
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\n' +
      '__LABORER_PATH_END__\n' +
      'Bye\n'
    expect(extractPathFromShellOutput(output)).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    )
  })

  it('returns null when start marker is missing', () => {
    expect(extractPathFromShellOutput('/opt/homebrew/bin:/usr/bin')).toBeNull()
  })

  it('returns null when end marker is missing', () => {
    expect(
      extractPathFromShellOutput(
        '__LABORER_PATH_START__\n/opt/homebrew/bin:/usr/bin\n'
      )
    ).toBeNull()
  })

  it('returns null when PATH value between markers is empty', () => {
    expect(
      extractPathFromShellOutput(
        '__LABORER_PATH_START__\n\n__LABORER_PATH_END__\n'
      )
    ).toBeNull()
  })

  it('returns null when PATH value is only whitespace', () => {
    expect(
      extractPathFromShellOutput(
        '__LABORER_PATH_START__\n   \n__LABORER_PATH_END__\n'
      )
    ).toBeNull()
  })

  it('handles markers on the same line', () => {
    expect(
      extractPathFromShellOutput(
        '__LABORER_PATH_START__/usr/bin__LABORER_PATH_END__'
      )
    ).toBe('/usr/bin')
  })

  it('handles a complex multi-segment PATH', () => {
    const complexPath = [
      '/Users/dev/.nvm/versions/node/v20.10.0/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/System/Cryptexes/App/usr/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/Users/dev/.cargo/bin',
      '/Users/dev/go/bin',
    ].join(':')

    expect(
      extractPathFromShellOutput(
        `__LABORER_PATH_START__\n${complexPath}\n__LABORER_PATH_END__\n`
      )
    ).toBe(complexPath)
  })
})

describe('readPathFromLoginShell', () => {
  it('invokes the shell with -ilc and the PATH capture command', () => {
    const execFile = vi.fn(
      () => '__LABORER_PATH_START__\n/a:/b\n__LABORER_PATH_END__\n'
    )

    const result = readPathFromLoginShell('/opt/homebrew/bin/fish', execFile)

    expect(result).toBe('/a:/b')
    expect(execFile).toHaveBeenCalledTimes(1)

    const firstCall = execFile.mock.calls[0] as unknown as [
      string,
      readonly string[],
      { encoding: 'utf8'; timeout: number },
    ]
    expect(firstCall[0]).toBe('/opt/homebrew/bin/fish')
    expect(firstCall[1]).toHaveLength(2)
    expect(firstCall[1][0]).toBe('-ilc')
    expect(firstCall[1][1]).toContain('printenv PATH')
    expect(firstCall[1][1]).toContain('__LABORER_PATH_START__')
    expect(firstCall[1][1]).toContain('__LABORER_PATH_END__')
    expect(firstCall[2]).toEqual({ encoding: 'utf8', timeout: 5000 })
  })

  it('returns undefined when shell output has no markers', () => {
    const execFile = vi.fn(() => '/usr/bin:/bin\n')

    const result = readPathFromLoginShell('/bin/zsh', execFile)
    expect(result).toBeUndefined()
  })

  it('returns undefined when shell output is empty', () => {
    const execFile = vi.fn(() => '')

    const result = readPathFromLoginShell('/bin/bash', execFile)
    expect(result).toBeUndefined()
  })

  it('works with a bash shell path', () => {
    const execFile = vi.fn(
      () =>
        '__LABORER_PATH_START__\n/usr/local/bin:/usr/bin:/bin\n__LABORER_PATH_END__\n'
    )

    const result = readPathFromLoginShell('/bin/bash', execFile)

    expect(result).toBe('/usr/local/bin:/usr/bin:/bin')
    const firstCall = execFile.mock.calls[0] as unknown as [string]
    expect(firstCall[0]).toBe('/bin/bash')
  })

  it('works with a zsh shell path', () => {
    const execFile = vi.fn(
      () =>
        '__LABORER_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__LABORER_PATH_END__\n'
    )

    const result = readPathFromLoginShell('/bin/zsh', execFile)

    expect(result).toBe('/opt/homebrew/bin:/usr/bin')
    const firstCall = execFile.mock.calls[0] as unknown as [string]
    expect(firstCall[0]).toBe('/bin/zsh')
  })
})
