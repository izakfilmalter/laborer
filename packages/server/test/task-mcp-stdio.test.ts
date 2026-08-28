import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'

interface JsonRpcResponse {
  readonly error?: unknown
  readonly id: number
  readonly result?: Record<string, unknown>
}

const roots: string[] = []
const processes: ChildProcessWithoutNullStreams[] = []
const LOG_LINE_PATTERN = /^\d{4}-\d{2}-\d{2}T.* pid=\d+ starting$/m

afterEach(async () => {
  for (const child of processes.splice(0)) {
    child.kill('SIGTERM')
    if (child.exitCode === null) {
      await once(child, 'exit')
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

const startServer = (root: string, home: string = root) => {
  const child = spawn(process.execPath, ['dist/task-mcp-main.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, HOME: home, XDG_STATE_HOME: join(root, 'state') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  processes.push(child)

  let stdout = ''
  let stderr = ''
  const stdoutLines: string[] = []
  const pending = new Map<number, (response: JsonRpcResponse) => void>()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      stdoutLines.push(line)
      const response = JSON.parse(line) as JsonRpcResponse
      pending.get(response.id)?.(response)
      pending.delete(response.id)
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  let id = 0
  const request = (method: string, params: unknown = {}) => {
    id += 1
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Timed out waiting for ${method}; stderr: ${stderr}`)
          ),
        5000
      )
      pending.set(id, (response) => {
        clearTimeout(timeout)
        resolve(response)
      })
      child.stdin.write(
        `${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`
      )
    })
  }

  return {
    child,
    request,
    stderr: () => stderr,
    stdoutLines: () => stdoutLines,
  }
}

const callTool = async (
  request: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
  name: string,
  args: Record<string, unknown>
) => {
  const response = await request('tools/call', { arguments: args, name })
  if (response.error !== undefined) {
    throw new Error(`${name} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result?.structuredContent as Record<string, unknown>
}

describe('task MCP stdio entry point', () => {
  it('packages the shared migration SQL beside the MCP bundle', () => {
    for (const migration of taskDbMigrations) {
      expect(
        readFileSync(
          join(
            import.meta.dirname,
            '..',
            'dist',
            'migrations',
            `${migration.name}.sql`
          ),
          'utf8'
        )
      ).toBe(migration.sql)
    }
  })

  it('fails before loading the runtime on unsupported Node versions', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "Object.defineProperty(process, 'version', { value: 'v23.9.0' }); await import('./dist/task-mcp-main.mjs')",
      ],
      {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
      }
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'Laborer MCP requires Node.js 24 or newer (running v23.9.0).\n'
    )
  })

  it('lists all tools and completes task CRUD with protocol-only stdout', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-mcp-stdio-')))
    roots.push(root)
    const state = join(root, 'state', 'laborer')
    const project = join(root, 'project')
    mkdirSync(state, { recursive: true })
    mkdirSync(project)
    const database = NativeLaborerDatabase.connect(
      join(state, 'laborer.sqlite')
    )
    database.initialize()
    database.insertProject({
      canonicalGitCommonDir: project,
      id: 'project-1',
      name: 'Project',
      repoId: 'repo-1',
      rootPath: project,
    })
    database.close()

    const server = startServer(root)
    const initialized = await server.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
      protocolVersion: '2025-06-18',
    })
    expect(initialized.error).toBeUndefined()
    server.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
    )

    const listed = await server.request('tools/list')
    const tools = listed.result?.tools as { readonly name: string }[]
    expect(tools.map(({ name }) => name).sort()).toEqual([
      'consume_browser_context',
      'create_label',
      'create_task',
      'delete_label',
      'delete_task',
      'get_task',
      'list_browser_context',
      'list_labels',
      'list_projects',
      'list_review_comments',
      'list_tasks',
      'preview_click',
      'preview_evaluate',
      'preview_navigate',
      'preview_open',
      'preview_press',
      'preview_recording_start',
      'preview_recording_stop',
      'preview_resize',
      'preview_scroll',
      'preview_snapshot',
      'preview_status',
      'preview_type',
      'preview_wait_for',
      'reply_to_review_comment',
      'resolve_review_comment',
      'set_task_labels',
      'update_label',
      'update_task',
    ])

    const projects = await callTool(server.request, 'list_projects', {})
    expect(projects.projects).toEqual([
      { name: 'Project', repoPath: project, shortName: 'PROJECT' },
    ])
    const created = await callTool(server.request, 'create_task', {
      description: 'Initial description',
      path: project,
      title: 'Stdio task',
    })
    const taskId = created.identifier as string
    expect(taskId).toBe('PROJECT-1')
    expect(
      (await callTool(server.request, 'get_task', { id: taskId })).title
    ).toBe('Stdio task')
    const updated = await callTool(server.request, 'update_task', {
      expected_revision: 1,
      id: taskId,
      title: 'Updated task',
    })
    expect(updated.title).toBe('Updated task')
    const listedTasks = await callTool(server.request, 'list_tasks', {})
    expect(listedTasks.tasks).toEqual([
      expect.objectContaining({ identifier: taskId }),
    ])
    // Agents see the seeded defaults without creating anything first.
    const seeded = (await callTool(server.request, 'list_labels', {}))
      .labels as ReadonlyArray<{ readonly name: string }>
    expect(seeded.map(({ name }) => name)).toEqual(['BE', 'FE', 'Full Stack'])
    const label = await callTool(server.request, 'create_label', {
      name: 'Bug',
    })
    expect(label).toMatchObject({ name: 'Bug' })
    expect(label).not.toHaveProperty('rootPath')
    const renamed = await callTool(server.request, 'update_label', {
      color: 'teal',
      expected_revision: 1,
      id: label.id as string,
      name: 'Defect',
    })
    expect(renamed).toMatchObject({ color: 'teal', name: 'Defect' })
    expect(
      (await callTool(server.request, 'list_labels', {})).labels
    ).toContainEqual(expect.objectContaining({ id: label.id }))
    const labeled = await callTool(server.request, 'set_task_labels', {
      expected_revision: 2,
      id: taskId,
      label_ids: [label.id as string],
    })
    expect(labeled.labelIds).toEqual([label.id])
    await callTool(server.request, 'delete_label', {
      expected_revision: 2,
      id: label.id as string,
    })
    expect(
      (await callTool(server.request, 'get_task', { id: taskId })).labelIds
    ).toEqual([])

    const deleted = await callTool(server.request, 'delete_task', {
      expected_revision: 4,
      id: taskId,
    })
    expect(deleted.status).toBe('cancelled')

    expect(server.stderr()).toContain('pid=')
    const log = readFileSync(
      join(
        root,
        'Library',
        'Application Support',
        'Laborer',
        'logs',
        'laborer-mcp.log'
      ),
      'utf8'
    )
    expect(log).toMatch(LOG_LINE_PATTERN)
    expect(
      server.stdoutLines().every((line) => JSON.parse(line).jsonrpc === '2.0')
    ).toBe(true)
  })

  it('continues serving tools when the log path is unwritable', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-log-failure-'))
    )
    roots.push(root)
    const state = join(root, 'state', 'laborer')
    const project = join(root, 'project')
    mkdirSync(state, { recursive: true })
    mkdirSync(project)
    const database = NativeLaborerDatabase.connect(
      join(state, 'laborer.sqlite')
    )
    database.initialize()
    database.insertProject({
      canonicalGitCommonDir: project,
      id: 'project-1',
      name: 'Project',
      repoId: 'repo-1',
      rootPath: project,
    })
    database.close()

    const server = startServer(root, '/dev/null')
    expect(
      (
        await server.request('initialize', {
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
          protocolVersion: '2025-06-18',
        })
      ).error
    ).toBeUndefined()
    const projects = await callTool(server.request, 'list_projects', {})
    expect(projects.projects).toEqual([
      { name: 'Project', repoPath: project, shortName: 'PROJECT' },
    ])
  })
})
