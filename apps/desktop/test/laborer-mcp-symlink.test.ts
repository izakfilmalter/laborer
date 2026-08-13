import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installLaborerMcpSymlink,
  refreshLaborerMcpSymlink,
} from '../src/laborer-mcp-symlink.js'

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-mcp-symlink-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Laborer MCP symlink installer', () => {
  it('creates the bin directory and symlink on a fresh install', () => {
    const homeDirectory = makeTemporaryDirectory()
    const scriptPath = join(homeDirectory, 'bundle', 'laborer-mcp.mjs')

    const installedPath = installLaborerMcpSymlink({
      homeDirectory,
      scriptPath,
    })

    expect(installedPath).toBe(join(homeDirectory, '.local/bin/laborer-mcp'))
    expect(readlinkSync(installedPath)).toBe(scriptPath)
  })

  it('atomically replaces a stale symlink with the current bundle path', () => {
    const homeDirectory = makeTemporaryDirectory()
    const firstScript = join(homeDirectory, 'old.app', 'laborer-mcp.mjs')
    const secondScript = join(homeDirectory, 'new.app', 'laborer-mcp.mjs')

    installLaborerMcpSymlink({ homeDirectory, scriptPath: firstScript })
    const installedPath = installLaborerMcpSymlink({
      homeDirectory,
      scriptPath: secondScript,
    })

    expect(readlinkSync(installedPath)).toBe(secondScript)
  })

  it('does not overwrite a user-owned command at the stable path', () => {
    const homeDirectory = makeTemporaryDirectory()
    const commandPath = join(homeDirectory, '.local', 'bin', 'laborer-mcp')
    const warn = vi.fn()
    mkdirSync(join(homeDirectory, '.local', 'bin'), { recursive: true })
    writeFileSync(commandPath, 'user command')

    refreshLaborerMcpSymlink({
      homeDirectory,
      scriptPath: '/Applications/Laborer.app/laborer-mcp.mjs',
      warn,
    })

    expect(readFileSync(commandPath, 'utf8')).toBe('user command')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('Refusing to replace non-symlink')
  })

  it('logs a warning and returns without throwing when installation fails', () => {
    const homeDirectory = makeTemporaryDirectory()
    const binPath = join(homeDirectory, '.local', 'bin')
    writeFileSync(join(homeDirectory, '.local'), 'not a directory')
    const warn = vi.fn()

    expect(() =>
      refreshLaborerMcpSymlink({
        homeDirectory,
        scriptPath: '/Applications/Laborer.app/laborer-mcp.mjs',
        warn,
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain(
      'Could not install Laborer MCP command'
    )
    expect(warn.mock.calls[0]?.[0]).toContain(binPath)
  })
})
