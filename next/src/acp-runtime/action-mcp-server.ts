import { readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Effect } from 'effect'
import { actionDefinition } from '../action-catalog.ts'
import { executionControlDefinition } from '../execution-control-catalog.ts'
import { productionGeneratedMutationCatalog } from '../generated-mutation-catalog.ts'
import { ACTION_MCP_CONTROL_TIMEOUT_MILLIS } from './action-mcp-timeouts.ts'

const controlUrl = process.env.LABORER_ACTION_CONTROL_URL
const bootstrapPath = process.env.LABORER_ACTION_BOOTSTRAP_PATH
const catalogPath = process.env.LABORER_ACTION_CATALOG_PATH
const serverName = process.env.LABORER_ACTION_SERVER_NAME
const serverGeneration = process.env.LABORER_ACTION_SERVER_GENERATION
const MAX_CATALOG_BYTES = 1024 * 1024
const CATALOG_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/

const decodeCatalog = (source: string) => {
  if (Buffer.byteLength(source, 'utf8') > MAX_CATALOG_BYTES) {
    throw new Error('Action catalog is oversized')
  }
  const candidate: unknown = JSON.parse(source)
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('fingerprint' in candidate) ||
    typeof candidate.fingerprint !== 'string' ||
    !CATALOG_FINGERPRINT_PATTERN.test(candidate.fingerprint) ||
    !('tools' in candidate)
  ) {
    throw new Error('Action catalog is invalid')
  }
  const decoded = ListToolsResultSchema.safeParse({ tools: candidate.tools })
  if (
    !decoded.success ||
    decoded.data.tools.length > 256 ||
    new Set(decoded.data.tools.map((tool) => tool.name)).size !==
      decoded.data.tools.length
  ) {
    throw new Error('Action catalog is invalid')
  }
  return {
    fingerprint: candidate.fingerprint,
    tools: decoded.data.tools,
  }
}

if (
  controlUrl === undefined ||
  bootstrapPath === undefined ||
  serverName === undefined ||
  serverGeneration === undefined
) {
  process.stderr.write('[laborer-actions] bootstrap configuration missing\n')
  process.exitCode = 1
} else {
  const bootstrap = (await readFile(bootstrapPath, 'utf8')).trim()
  const catalog = decodeCatalog(
    catalogPath === undefined
      ? JSON.stringify(productionGeneratedMutationCatalog)
      : await readFile(catalogPath, 'utf8')
  )
  const toolNames = new Set(catalog.tools.map((tool) => tool.name))
  const callControl = async (
    path: string,
    body: unknown,
    requestSignal?: AbortSignal
  ): Promise<unknown> => {
    const timeoutSignal = AbortSignal.timeout(ACTION_MCP_CONTROL_TIMEOUT_MILLIS)
    const signal =
      requestSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([requestSignal, timeoutSignal])
    const response = await fetch(`${controlUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${bootstrap}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal,
    })
    const source = await response.text()
    if (!response.ok || Buffer.byteLength(source, 'utf8') > 64 * 1024) {
      throw new Error('Action control request failed')
    }
    return JSON.parse(source) as unknown
  }

  const server = new Server(
    { name: serverName, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: catalog.tools })
  )
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const productionAction =
      catalog.fingerprint === productionGeneratedMutationCatalog.fingerprint
        ? actionDefinition(request.params.name)
        : undefined
    const control = executionControlDefinition(request.params.name)
    if (!toolNames.has(request.params.name)) {
      return {
        content: [{ text: 'Unsupported Action.', type: 'text' as const }],
        isError: true,
      }
    }
    try {
      const result = await callControl(
        '/invoke',
        {
          catalogFingerprint: catalog.fingerprint,
          input: request.params.arguments ?? {},
          serverGeneration,
          serverName,
          toolName: request.params.name,
        },
        extra.signal
      )
      let encoded: unknown
      if (productionAction !== undefined) {
        encoded = await Effect.runPromise(productionAction.encodeResult(result))
      } else if (control !== undefined) {
        encoded = await Effect.runPromise(control.encodeResult(result))
      } else {
        // The parent validates the generic Execution receipt before returning
        // it. Registered terminal results and command evidence never cross
        // this capability process.
        encoded = result
      }
      if (
        typeof encoded !== 'object' ||
        encoded === null ||
        Array.isArray(encoded)
      ) {
        throw new Error('Action result is invalid')
      }
      return {
        content: [{ text: JSON.stringify(encoded), type: 'text' as const }],
        structuredContent: { ...encoded },
      }
    } catch {
      return {
        content: [
          {
            text: 'Action invocation was rejected or unavailable.',
            type: 'text' as const,
          },
        ],
        isError: true,
      }
    }
  })
  server.oninitialized = async () => {
    try {
      await callControl('/ready', {
        catalogFingerprint: catalog.fingerprint,
        environmentNames: Object.keys(process.env).sort(),
        serverGeneration,
        serverName,
        tools: catalog.tools,
      })
    } catch {
      process.stderr.write('[laborer-actions] readiness failed\n')
      process.exitCode = 1
    }
  }
  await server.connect(new StdioServerTransport())
}
