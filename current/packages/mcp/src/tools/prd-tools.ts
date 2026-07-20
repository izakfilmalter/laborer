import { McpServer, Tool, Toolkit } from '@effect/ai'
import {
  PrdResponse,
  type ProjectResponse,
  RpcError,
} from '@laborer/shared/rpc'
import { Effect, Layer, Schema } from 'effect'
import { LaborerRpcClient } from '../services/laborer-rpc-client.js'
import { ProjectDiscovery } from '../services/project-discovery.js'

const ReadPrdResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  filePath: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  content: Schema.String,
})

const ReadPrdParams = {
  prdId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
}

const CreatePrdTool = Tool.make('create_prd', {
  description:
    'Create a PRD for the current Laborer project using a title and markdown content.',
  parameters: {
    title: Schema.String,
    content: Schema.String,
  },
  success: PrdResponse,
  failure: RpcError,
})

const ReadPrdTool = Tool.make('read_prd', {
  description:
    'Read a PRD by id or exact title from the current Laborer project and return its markdown content.',
  parameters: ReadPrdParams,
  success: ReadPrdResponse,
  failure: RpcError,
})

const UpdatePrdTool = Tool.make('update_prd', {
  description:
    "Overwrite an existing PRD's markdown content by PRD id in the current Laborer project.",
  parameters: {
    prdId: Schema.String,
    content: Schema.String,
  },
  success: PrdResponse,
  failure: RpcError,
})

const ListPrdsTool = Tool.make('list_prds', {
  description:
    'List PRDs for the current Laborer project with their metadata and status summaries.',
  success: Schema.Array(PrdResponse),
  failure: RpcError,
})

export const PrdTools = Toolkit.make(
  CreatePrdTool,
  ReadPrdTool,
  UpdatePrdTool,
  ListPrdsTool
)

const resolveCurrentProject = (projectDiscovery: ProjectDiscovery['Type']) =>
  Effect.fn('PrdTools.resolveCurrentProject')(function* () {
    return yield* projectDiscovery.discoverProject()
  })

const resolvePrdId = (
  project: ProjectResponse,
  laborerRpcClient: LaborerRpcClient['Type'],
  params: {
    readonly prdId?: string | undefined
    readonly title?: string | undefined
  }
) =>
  Effect.fn('PrdTools.resolvePrdId')(function* () {
    if (params.prdId) {
      return params.prdId
    }

    if (!params.title) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'Provide either prdId or title when calling read_prd.',
      })
    }

    const prds = yield* laborerRpcClient.listPrds({ projectId: project.id })
    const matchedPrd = prds.find((prd) => prd.title === params.title)

    if (!matchedPrd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `No PRD titled "${params.title}" exists in project ${project.name}.`,
      })
    }

    return matchedPrd.id
  })

export const makePrdToolHandlers = Effect.gen(function* () {
  const projectDiscovery = yield* ProjectDiscovery
  const laborerRpcClient = yield* LaborerRpcClient
  const getCurrentProject = resolveCurrentProject(projectDiscovery)

  return PrdTools.of({
    create_prd: Effect.fn('PrdTools.create_prd')(function* ({
      title,
      content,
    }) {
      const project = yield* getCurrentProject()
      return yield* laborerRpcClient.createPrd({
        projectId: project.id,
        title,
        content,
      })
    }),
    list_prds: Effect.fn('PrdTools.list_prds')(function* () {
      const project = yield* getCurrentProject()
      return yield* laborerRpcClient.listPrds({ projectId: project.id })
    }),
    read_prd: Effect.fn('PrdTools.read_prd')(function* (params) {
      const project = yield* getCurrentProject()
      const prdId = yield* resolvePrdId(project, laborerRpcClient, {
        prdId: params.prdId,
        title: params.title,
      })()
      return yield* laborerRpcClient.readPrd({ prdId })
    }),
    update_prd: Effect.fn('PrdTools.update_prd')(function* ({
      prdId,
      content,
    }) {
      yield* getCurrentProject()
      return yield* laborerRpcClient.updatePrd({ prdId, content })
    }),
  })
})

export const PrdToolsLayer = McpServer.toolkit(PrdTools).pipe(
  Layer.provide(PrdTools.toLayer(makePrdToolHandlers))
)
