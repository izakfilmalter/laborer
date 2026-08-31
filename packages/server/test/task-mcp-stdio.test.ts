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

const callToolResult = async (
  request: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
  name: string,
  args: Record<string, unknown>
) => {
  const response = await request('tools/call', { arguments: args, name })
  if (response.error !== undefined) {
    throw new Error(`${name} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result as {
    readonly content?: readonly { readonly text?: string }[]
    readonly isError?: boolean
    readonly structuredContent?: Record<string, unknown>
  }
}

const callTool = async (
  request: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
  name: string,
  args: Record<string, unknown>
) => {
  const result = await callToolResult(request, name, args)
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
  }
  return result.structuredContent as Record<string, unknown>
}

/** The text a failing tool call reports back to the calling agent. */
const toolFailureText = async (
  request: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
  name: string,
  args: Record<string, unknown>
) => {
  const result = await callToolResult(request, name, args)
  if (result.isError !== true) {
    throw new Error(
      `${name} unexpectedly succeeded: ${JSON.stringify(result.structuredContent)}`
    )
  }
  return (result.content ?? []).map((part) => part.text ?? '').join('\n')
}

interface ToolDefinition {
  readonly inputSchema: {
    readonly properties?: Record<string, Record<string, unknown>>
    readonly required?: readonly string[]
  }
  readonly name: string
  readonly outputSchema?: Record<string, unknown>
}

const listTools = async (server: ReturnType<typeof startServer>) => {
  const listed = await server.request('tools/list')
  return (listed.result?.tools ?? []) as readonly ToolDefinition[]
}

/** Every node of an advertised schema, keyed by a readable JSON path. */
const schemaNodes = (
  node: unknown,
  path: string
): readonly (readonly [string, Record<string, unknown>])[] => {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      schemaNodes(child, `${path}[${String(index)}]`)
    )
  }
  if (typeof node !== 'object' || node === null) {
    return []
  }
  const record = node as Record<string, unknown>
  return [
    [path, record] as const,
    ...Object.entries(record).flatMap(([key, value]) =>
      schemaNodes(value, `${path}.${key}`)
    ),
  ]
}

const seedProject = (root: string) => {
  const state = join(root, 'state', 'laborer')
  const project = join(root, 'project')
  mkdirSync(state, { recursive: true })
  mkdirSync(project)
  const database = NativeLaborerDatabase.connect(join(state, 'laborer.sqlite'))
  database.initialize()
  database.insertProject({
    canonicalGitCommonDir: project,
    id: 'project-1',
    name: 'Project',
    repoId: 'repo-1',
    rootPath: project,
  })
  database.close()
  return project
}

const handshake = async (server: ReturnType<typeof startServer>) => {
  const initialized = await server.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  })
  if (initialized.error !== undefined) {
    throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`)
  }
  server.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
  )
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
    const project = seedProject(root)

    const server = startServer(root)
    await handshake(server)

    const listed = await server.request('tools/list')
    const tools = listed.result?.tools as { readonly name: string }[]
    expect(tools.map(({ name }) => name).sort()).toEqual([
      'add_labels',
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
      'remove_labels',
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
      expected_revision: created.revision,
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
      expected_revision: label.revision,
      id: label.id as string,
      name: 'Defect',
    })
    expect(renamed).toMatchObject({ color: 'teal', name: 'Defect' })
    expect(
      (await callTool(server.request, 'list_labels', {})).labels
    ).toContainEqual(expect.objectContaining({ id: label.id }))
    const labeled = await callTool(server.request, 'set_task_labels', {
      expected_revision: updated.revision,
      id: taskId,
      label_ids: [label.id as string],
    })
    expect(labeled.labelIds).toEqual([label.id])
    await callTool(server.request, 'delete_label', {
      expected_revision: renamed.revision,
      id: label.id as string,
    })
    const stripped = await callTool(server.request, 'get_task', { id: taskId })
    expect(stripped.labelIds).toEqual([])

    const deleted = await callTool(server.request, 'delete_task', {
      expected_revision: stripped.revision,
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

  it('advertises expected_revision on every tool that honours it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-mcp-cas-')))
    roots.push(root)
    seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const listed = await server.request('tools/list')
    const byName = new Map(
      (listed.result?.tools as readonly ToolDefinition[]).map((tool) => [
        tool.name,
        tool,
      ])
    )

    for (const name of [
      'delete_label',
      'delete_task',
      'set_task_labels',
      'update_label',
      'update_task',
    ]) {
      const tool = byName.get(name)
      const property = tool?.inputSchema.properties?.expected_revision
      // The key was validated at runtime long before it was advertised, so an
      // agent could only discover it by failing a call.
      expect(property, `${name} must declare expected_revision`).toBeDefined()
      expect(
        JSON.stringify(property),
        `${name} must describe where the revision comes from`
      ).toContain('get_task')
      // A nested `allOf` fragment is what hid this key from clients before.
      expect(JSON.stringify(property)).not.toContain('allOf')
      expect(
        tool?.inputSchema.required ?? [],
        `${name} must accept an omitted expected_revision`
      ).not.toContain('expected_revision')
    }

    // Resolving a review thread still demands the guard, and still declares it.
    const resolve = byName.get('resolve_review_comment')
    expect(resolve?.inputSchema.properties?.expected_revision).toEqual({
      type: 'integer',
    })
    expect(resolve?.inputSchema.required).toContain('expected_revision')

    // The commutative label tools deliberately carry no revision at all.
    for (const name of ['add_labels', 'remove_labels']) {
      const tool = byName.get(name)
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        'id',
        'label_ids',
      ])
    }

    // Labels at creation are only reachable if the key is advertised.
    const create = byName.get('create_task')
    const createLabels = create?.inputSchema.properties?.label_ids
    expect(createLabels, 'create_task must declare label_ids').toBeDefined()
    expect(JSON.stringify(createLabels)).toContain('list_labels')
    // A nested `allOf`/`anyOf` fragment is what hides a key from clients.
    expect(JSON.stringify(createLabels)).not.toContain('allOf')
    expect(JSON.stringify(createLabels)).not.toContain('anyOf')
    expect(
      create?.inputSchema.required ?? [],
      'create_task must accept an omitted label_ids'
    ).not.toContain('label_ids')
  })

  it('advertises a flat input schema for every tool', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-mcp-flat-')))
    roots.push(root)
    seedProject(root)
    const server = startServer(root)
    await handshake(server)

    for (const tool of await listTools(server)) {
      for (const [path, node] of schemaNodes(
        tool.inputSchema,
        tool.name
      ).values()) {
        // An anonymous `allOf` fragment is how a check on a value is emitted,
        // and clients that normalise `inputSchema` drop the property whole
        // rather than map it — the bug that hid expected_revision.
        expect(
          Object.keys(node),
          `${path} must not wrap a check`
        ).not.toContain('allOf')
        // `$defs`/`$ref` appear when the emitter dedupes two identical unions
        // into a generated definition, which the same clients cannot follow.
        expect(
          Object.keys(node),
          `${path} must inline its types`
        ).not.toContain('$ref')
        const branches = node.anyOf
        if (!Array.isArray(branches)) {
          continue
        }
        const members = branches as readonly Record<string, unknown>[]
        // `optional` over a `NullOr` nested one union inside another and
        // advertised `null` twice, which agents read as `string | null | null`.
        expect(
          members.filter((member) => Array.isArray(member.anyOf)),
          `${path} must not nest a union inside a union`
        ).toEqual([])
        expect(
          members.filter((member) => member.type === 'null'),
          `${path} must offer null at most once`
        ).not.toHaveLength(2)
      }

      for (const [name, property] of Object.entries(
        tool.inputSchema.properties ?? {}
      )) {
        // Numbers are the one shape whose description the emitter turns into
        // an `allOf` fragment, so those are documented on the tool instead.
        if (property.type === 'integer' || property.type === 'number') {
          continue
        }
        expect(
          property.description,
          `${tool.name}.${name} must document itself`
        ).toEqual(expect.any(String))
      }
    }
  })

  it('answers a call with structured content and its serialization', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-structured-'))
    )
    roots.push(root)
    const project = seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const listProjects = (await listTools(server)).find(
      (tool) => tool.name === 'list_projects'
    )
    // Declaring outputSchema is what lets a client parse the result rather
    // than guess at it; Effect emits one for every object-shaped success.
    expect(listProjects?.outputSchema).toMatchObject({ type: 'object' })

    const result = await callToolResult(server.request, 'list_projects', {})
    const projects = [
      { name: 'Project', repoPath: project, shortName: 'PROJECT' },
    ]
    expect(result.structuredContent).toEqual({ projects })
    // Effect's McpServer also serializes the same value into a single text
    // block, which the MCP spec asks for so pre-2025-06-18 clients still see
    // a result. A client that reads only `content` therefore sees JSON as a
    // string: that is its own normalisation to undo, not a server defect.
    expect(result.content).toHaveLength(1)
    expect(JSON.parse(result.content?.[0]?.text ?? '')).toEqual({ projects })
  })

  it('clears a description with null and leaves it alone when omitted', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-description-'))
    )
    roots.push(root)
    const project = seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const created = await callTool(server.request, 'create_task', {
      description: 'Written at creation',
      path: project,
      title: 'Described task',
    })
    const id = created.identifier as string

    // Omitting the key leaves the description as it was.
    expect(
      (
        await callTool(server.request, 'update_task', {
          id,
          title: 'Retitled only',
        })
      ).description
    ).toBe('Written at creation')

    // An explicit null is the only way to clear it.
    expect(
      (
        await callTool(server.request, 'update_task', {
          description: null,
          id,
        })
      ).description
    ).toBeNull()

    // A null revision reads as "no guard", the same as leaving the key out.
    const rewritten = await callTool(server.request, 'update_task', {
      description: 'Written again',
      expected_revision: null,
      id,
    })
    expect(rewritten.description).toBe('Written again')

    // create_task accepts the same null without staging a description.
    expect(
      (
        await callTool(server.request, 'create_task', {
          description: null,
          path: project,
          title: 'Undescribed task',
        })
      ).description
    ).toBeNull()
  })

  it('mutates without a revision and still enforces a supplied one', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-revision-'))
    )
    roots.push(root)
    const project = seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const task = await callTool(server.request, 'create_task', {
      path: project,
      title: 'Revision task',
    })
    const taskId = task.identifier as string

    // Omitted revision: last write wins.
    const retitled = await callTool(server.request, 'update_task', {
      id: taskId,
      title: 'Retitled without a revision',
    })
    expect(retitled.title).toBe('Retitled without a revision')

    const label = await callTool(server.request, 'create_label', {
      name: 'Unguarded',
    })
    const relabeled = await callTool(server.request, 'set_task_labels', {
      id: taskId,
      label_ids: [label.id as string],
    })
    expect(relabeled.labelIds).toEqual([label.id])
    const recolored = await callTool(server.request, 'update_label', {
      color: 'teal',
      id: label.id as string,
    })
    expect(recolored.color).toBe('teal')

    // Supplied revision: still a strict compare-and-swap.
    expect(
      await toolFailureText(server.request, 'update_task', {
        expected_revision: 1,
        id: taskId,
        title: 'Stale write',
      })
    ).toContain('CAS_CONFLICT')
    expect(
      await toolFailureText(server.request, 'set_task_labels', {
        expected_revision: 1,
        id: taskId,
        label_ids: [],
      })
    ).toContain('CAS_CONFLICT')
    expect(
      await toolFailureText(server.request, 'update_label', {
        expected_revision: 1,
        id: label.id as string,
        name: 'Stale label',
      })
    ).toContain('CAS_CONFLICT')
    expect(
      (await callTool(server.request, 'get_task', { id: taskId })).title
    ).toBe('Retitled without a revision')

    await callTool(server.request, 'delete_label', { id: label.id as string })
    const cancelled = await callTool(server.request, 'delete_task', {
      id: taskId,
    })
    expect(cancelled.status).toBe('cancelled')
  })

  it('adds and removes labels idempotently without a revision', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-labels-'))
    )
    roots.push(root)
    const project = seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const task = await callTool(server.request, 'create_task', {
      path: project,
      title: 'Label task',
    })
    const taskId = task.identifier as string
    const first = await callTool(server.request, 'create_label', {
      name: 'First',
    })
    const second = await callTool(server.request, 'create_label', {
      name: 'Second',
    })

    const added = await callTool(server.request, 'add_labels', {
      id: taskId,
      label_ids: [first.id as string],
    })
    expect(added.labelIds).toEqual([first.id])

    // A second agent adds another id without ever reading a revision; the
    // first agent's label survives, which set_task_labels could not promise.
    const both = await callTool(server.request, 'add_labels', {
      id: taskId,
      label_ids: [second.id as string],
    })
    expect(both.labelIds).toEqual([first.id, second.id])

    const repeated = await callTool(server.request, 'add_labels', {
      id: taskId,
      label_ids: [first.id as string, second.id as string],
    })
    expect(repeated.labelIds).toEqual([first.id, second.id])
    expect(repeated.revision).toBe(both.revision)

    const removed = await callTool(server.request, 'remove_labels', {
      id: taskId,
      label_ids: [first.id as string],
    })
    expect(removed.labelIds).toEqual([second.id])
    const removedAgain = await callTool(server.request, 'remove_labels', {
      id: taskId,
      label_ids: [first.id as string],
    })
    expect(removedAgain.labelIds).toEqual([second.id])
    expect(removedAgain.revision).toBe(removed.revision)

    expect(
      await toolFailureText(server.request, 'add_labels', {
        id: taskId,
        label_ids: ['label-that-does-not-exist'],
      })
    ).toContain('Unknown labels')
    expect(
      await toolFailureText(server.request, 'add_labels', {
        id: 'PROJECT-404',
        label_ids: [first.id as string],
      })
    ).toContain('NOT_FOUND')
  })

  it('creates a labeled task in one call', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-create-labels-'))
    )
    roots.push(root)
    const project = seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const label = await callTool(server.request, 'create_label', {
      name: 'Bug',
    })

    const labeled = await callTool(server.request, 'create_task', {
      label_ids: [label.id as string],
      path: project,
      title: 'Labeled at birth',
    })
    // One call, not create → get_task → set_task_labels.
    expect(labeled.labelIds).toEqual([label.id])
    expect(labeled.revision).toBe(1)

    const plain = await callTool(server.request, 'create_task', {
      path: project,
      title: 'Unlabeled',
    })
    expect(plain.labelIds).toEqual([])

    expect(
      await toolFailureText(server.request, 'create_task', {
        label_ids: ['label-that-does-not-exist'],
        path: project,
        title: 'Never staged',
      })
    ).toContain('Unknown labels')
    // The rejected call staged nothing, so the board still holds two tasks.
    expect(
      (
        (await callTool(server.request, 'list_tasks', {})).tasks as readonly {
          readonly title: string
        }[]
      ).map(({ title }) => title)
    ).toEqual(['Labeled at birth', 'Unlabeled'])
  })

  it('accepts the project name and short name list_projects reports as a path', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-project-name-'))
    )
    roots.push(root)
    seedProject(root)
    const server = startServer(root)
    await handshake(server)

    const [project] = (await callTool(server.request, 'list_projects', {}))
      .projects as readonly {
      readonly name: string
      readonly repoPath: string
      readonly shortName: string
    }[]
    // Whatever list_projects hands back identifies the project, verbatim.
    expect(
      (
        await callTool(server.request, 'create_task', {
          path: project?.name ?? '',
          title: 'By name',
        })
      ).identifier
    ).toBe('PROJECT-1')
    expect(
      (
        await callTool(server.request, 'create_task', {
          path: (project?.shortName ?? '').toLowerCase(),
          title: 'By short name',
        })
      ).identifier
    ).toBe('PROJECT-2')
    expect(
      (
        (await callTool(server.request, 'list_tasks', { path: 'project' }))
          .tasks as readonly unknown[]
      ).length
    ).toBe(2)

    // The failure tells an agent which forms it could have used instead.
    const failure = await toolFailureText(server.request, 'create_task', {
      path: 'not-a-project',
      title: 'Orphan',
    })
    expect(failure).toContain('project name')
    expect(failure).toContain(`Project (PROJECT) at ${project?.repoPath ?? ''}`)

    const tools = (await server.request('tools/list', {})).result as {
      readonly tools: readonly ToolDefinition[]
    }
    for (const name of ['create_task', 'list_tasks']) {
      const description = tools.tools.find((tool) => tool.name === name)
        ?.inputSchema.properties?.path?.description
      expect(description, `${name} must document what path accepts`).toContain(
        'shortName'
      )
    }
  })

  it('continues serving tools when the log path is unwritable', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'laborer-mcp-log-failure-'))
    )
    roots.push(root)
    const project = seedProject(root)

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
