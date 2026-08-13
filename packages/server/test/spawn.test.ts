/**
 * Unit tests for the Node.js spawn utility.
 *
 * Tests cover all usage patterns found in the codebase:
 * - Successful exit with stdout/stderr capture
 * - Non-zero exit code
 * - stdout/stderr collection via `new Response(proc.stdout).text()`
 * - Process killing
 * - stdin piping between processes (stdout of proc A -> stdin of proc B)
 * - stdout: 'ignore' mode
 * - Custom cwd and env options
 */

import { describe, expect, it } from 'vitest'
import { spawn } from '../src/lib/spawn.js'

const TMP_DIR_PATTERN = /\/?tmp$/

describe('spawn', () => {
  it('returns exit code 0 for a successful command', async () => {
    const proc = spawn(['true'])
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  })

  it('returns non-zero exit code for a failing command', async () => {
    const proc = spawn(['false'])
    const exitCode = await proc.exited
    expect(exitCode).toBe(1)
  })

  it('captures stdout as a ReadableStream compatible with Response.text()', async () => {
    const proc = spawn(['echo', 'hello world'])
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('hello world')
  })

  it('captures stderr as a ReadableStream compatible with Response.text()', async () => {
    const proc = spawn(['sh', '-c', 'echo error >&2'])
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode).toBe(0)
    expect(stderr.trim()).toBe('error')
  })

  it('captures both stdout and stderr in parallel with Promise.all', async () => {
    const proc = spawn(['sh', '-c', 'echo out && echo err >&2'])
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('out')
    expect(stderr.trim()).toBe('err')
  })

  it('supports cwd option', async () => {
    const proc = spawn(['pwd'], { cwd: '/tmp' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    // /tmp may resolve to /private/tmp on macOS
    expect(stdout.trim()).toMatch(TMP_DIR_PATTERN)
  })

  it('supports custom env option', async () => {
    const proc = spawn(['sh', '-c', 'echo $MY_TEST_VAR'], {
      env: { ...process.env, MY_TEST_VAR: 'spawn-test-value' },
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('spawn-test-value')
  })

  it("returns stdout as empty stream when stdout is 'ignore'", async () => {
    const proc = spawn(['echo', 'ignored'], { stdout: 'ignore' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })

  it('can kill a long-running process', async () => {
    const proc = spawn(['sleep', '60'])
    expect(proc.pid).toBeDefined()

    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50))

    const killed = proc.kill()
    expect(killed).toBe(true)

    const exitCode = await proc.exited
    // Killed processes typically return null -> 1, or a signal-based code
    expect(typeof exitCode).toBe('number')
  })

  it('exposes the process pid', async () => {
    const proc = spawn(['echo', 'pid-test'])
    expect(proc.pid).toBeTypeOf('number')
    expect(proc.pid).toBeGreaterThan(0)
    await proc.exited
  })

  it('pipes stdout of one process into stdin of another', async () => {
    // Process A: produce data on stdout
    const producer = spawn(['echo', 'piped-data'])

    // Process B: read from stdin (which is producer's stdout)
    const consumer = spawn(['cat'], { stdin: producer.stdout })

    const [producerExit, consumerExit] = await Promise.all([
      producer.exited,
      consumer.exited,
    ])

    const consumerOutput = await new Response(consumer.stdout).text()

    expect(producerExit).toBe(0)
    expect(consumerExit).toBe(0)
    expect(consumerOutput.trim()).toBe('piped-data')
  })

  it('pipes larger data between processes correctly', async () => {
    // Generate 1000 lines of output and pipe through a processing command
    const producer = spawn([
      'sh',
      '-c',
      'seq 1 1000 | while read n; do echo "line-$n"; done',
    ])

    // Consumer: count lines via wc -l
    const consumer = spawn(['wc', '-l'], { stdin: producer.stdout })

    const [producerExit, consumerExit] = await Promise.all([
      producer.exited,
      consumer.exited,
    ])

    const output = await new Response(consumer.stdout).text()

    expect(producerExit).toBe(0)
    expect(consumerExit).toBe(0)
    expect(Number.parseInt(output.trim(), 10)).toBe(1000)
  })

  it('captures stderr from piped processes independently', async () => {
    // Producer writes to both stdout and stderr
    const producer = spawn(['sh', '-c', 'echo data && echo producer-error >&2'])

    const consumer = spawn(['cat'], { stdin: producer.stdout })

    const [producerExit, consumerExit] = await Promise.all([
      producer.exited,
      consumer.exited,
    ])

    const producerStderr = await new Response(producer.stderr).text()
    const consumerOutput = await new Response(consumer.stdout).text()

    expect(producerExit).toBe(0)
    expect(consumerExit).toBe(0)
    expect(producerStderr.trim()).toBe('producer-error')
    expect(consumerOutput.trim()).toBe('data')
  })

  it('throws when command array is empty', () => {
    expect(() => spawn([])).toThrow('command array must not be empty')
  })

  it('handles command not found gracefully', async () => {
    const proc = spawn(['nonexistent-command-12345'])
    // Should reject with a spawn error
    await expect(proc.exited).rejects.toThrow()
  })

  it('returns empty string from stdout when process produces no output', async () => {
    const proc = spawn(['true'])
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })
})
