import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { ConfigService } from './config-service.js'
import { LaborerStore } from './laborer-store.js'
import { TaskManager } from './task-manager.js'

interface LinearIssue {
  readonly identifier: string
  readonly title: string
}

interface LinearIssuesResponse {
  readonly importedCount: number
  readonly totalCount: number
}

interface LinearConfigValues {
  readonly apiKeyEnv: string
  readonly doneState: string
  readonly inProgressState: string
  readonly inReviewState: string
  readonly project: string | null
  readonly team: string
}

interface ParsedRlphConfig {
  readonly label: string
  readonly linear: LinearConfigValues | null
}

interface LinearIssueNode {
  readonly identifier?: unknown
  readonly title?: unknown
}

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const DEFAULT_RLPH_CONFIG_PATH = '.rlph/config.toml'
const DEFAULT_LABEL = 'rlph'
const DEFAULT_LINEAR_API_KEY_ENV = 'LINEAR_API_KEY'
const DEFAULT_IN_PROGRESS_STATE = 'In Progress'
const DEFAULT_IN_REVIEW_STATE = 'In Review'
const DEFAULT_DONE_STATE = 'Done'
const TOML_STRING_REGEX =
  /^(?<key>[A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?<value>"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/
const NEWLINE_REGEX = /\r?\n/u

const parseTomlString = (value: string): string => {
  if (value.startsWith('"')) {
    return JSON.parse(value) as string
  }

  return value.slice(1, -1)
}

const parseRootValue = (key: string, value: string, label: string): string => {
  if (key === 'label') {
    return value
  }

  return label
}

const applyLinearValue = (
  key: string,
  value: string,
  state: {
    apiKeyEnv: string
    doneState: string
    inProgressState: string
    inReviewState: string
    linearProject: string | null
    linearTeam: string | null
  }
): void => {
  switch (key) {
    case 'team':
      state.linearTeam = value
      break
    case 'project':
      state.linearProject = value
      break
    case 'api_key_env':
      state.apiKeyEnv = value
      break
    case 'in_progress_state':
      state.inProgressState = value
      break
    case 'in_review_state':
      state.inReviewState = value
      break
    case 'done_state':
      state.doneState = value
      break
    default:
      break
  }
}

const parseRlphConfig = (content: string): ParsedRlphConfig => {
  let currentSection: 'linear' | null = null
  let label = DEFAULT_LABEL
  const linearState = {
    apiKeyEnv: DEFAULT_LINEAR_API_KEY_ENV,
    doneState: DEFAULT_DONE_STATE,
    inProgressState: DEFAULT_IN_PROGRESS_STATE,
    inReviewState: DEFAULT_IN_REVIEW_STATE,
    linearProject: null as string | null,
    linearTeam: null as string | null,
  }

  for (const rawLine of content.split(NEWLINE_REGEX)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line === '[linear]' ? 'linear' : null
      continue
    }

    const match = line.match(TOML_STRING_REGEX)
    if (!(match?.groups?.key && match.groups.value)) {
      continue
    }

    const value = parseTomlString(match.groups.value)
    if (currentSection === null) {
      label = parseRootValue(match.groups.key, value, label)
      continue
    }

    applyLinearValue(match.groups.key, value, linearState)
  }

  return {
    label,
    linear:
      linearState.linearTeam === null
        ? null
        : {
            apiKeyEnv: linearState.apiKeyEnv,
            doneState: linearState.doneState,
            inProgressState: linearState.inProgressState,
            inReviewState: linearState.inReviewState,
            project: linearState.linearProject,
            team: linearState.linearTeam,
          },
  }
}

const getConfigPath = (
  projectRepoPath: string,
  rlphConfigPath: string | null
): string => {
  const configPath = rlphConfigPath?.trim() || DEFAULT_RLPH_CONFIG_PATH
  return isAbsolute(configPath)
    ? configPath
    : resolve(projectRepoPath, configPath)
}

const buildLinearFilter = (
  label: string,
  linearConfig: LinearConfigValues
): Record<string, unknown> => {
  const filter: Record<string, unknown> = {
    labels: { name: { eq: label } },
    state: {
      name: {
        nin: [
          linearConfig.inProgressState,
          linearConfig.inReviewState,
          linearConfig.doneState,
        ],
      },
      type: { nin: ['completed', 'canceled'] },
    },
    team: { key: { eq: linearConfig.team } },
  }

  if (linearConfig.project) {
    filter.project = { name: { eq: linearConfig.project } }
  }

  return filter
}

const parseLinearIssues = (payload: unknown): readonly LinearIssue[] => {
  if (!(payload && typeof payload === 'object')) {
    return []
  }

  const dataValue = Reflect.has(payload, 'data')
    ? Reflect.get(payload, 'data')
    : payload
  if (!(dataValue && typeof dataValue === 'object')) {
    return []
  }

  const issuesValue = Reflect.get(dataValue, 'issues')
  if (!(issuesValue && typeof issuesValue === 'object')) {
    return []
  }

  const nodesValue = Reflect.get(issuesValue, 'nodes')
  if (!Array.isArray(nodesValue)) {
    return []
  }

  return nodesValue.flatMap((node) => {
    const issue = node as LinearIssueNode
    if (
      typeof issue.identifier !== 'string' ||
      typeof issue.title !== 'string'
    ) {
      return []
    }

    return [{ identifier: issue.identifier, title: issue.title }]
  })
}

class LinearTaskImporter extends Context.Tag('@laborer/LinearTaskImporter')<
  LinearTaskImporter,
  {
    readonly importProjectIssues: (
      projectId: string
    ) => Effect.Effect<LinearIssuesResponse, RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    LinearTaskImporter,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const configService = yield* ConfigService
      const taskManager = yield* TaskManager

      const importProjectIssues = Effect.fn(
        'LinearTaskImporter.importProjectIssues'
      )(function* (projectId: string) {
        const project = store.query(tables.projects.where('id', projectId))[0]
        if (!project) {
          return yield* new RpcError({
            message: `Project not found: ${projectId}`,
            code: 'NOT_FOUND',
          })
        }

        const resolvedConfig = yield* configService.resolveConfig(
          project.repoPath,
          project.name
        )
        const configPath = getConfigPath(
          project.repoPath,
          resolvedConfig.rlphConfig.value
        )

        const configContent = yield* Effect.tryPromise({
          try: () => readFile(configPath, 'utf8'),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? `Could not read rlph config at ${configPath}: ${error.message}`
                  : `Could not read rlph config at ${configPath}`,
              code: 'LINEAR_CONFIG_NOT_FOUND',
            }),
        })

        const parsedConfig = yield* Effect.try({
          try: () => parseRlphConfig(configContent),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? `Invalid rlph config at ${configPath}: ${error.message}`
                  : `Invalid rlph config at ${configPath}`,
              code: 'LINEAR_CONFIG_INVALID',
            }),
        })

        if (!parsedConfig.linear) {
          return yield* new RpcError({
            message:
              'The rlph config is missing a [linear] section with a team value',
            code: 'LINEAR_CONFIG_MISSING_TEAM',
          })
        }

        const linearConfig = parsedConfig.linear

        const apiKey = process.env[linearConfig.apiKeyEnv]
        if (!apiKey) {
          return yield* new RpcError({
            message: `Linear API key not found in $${linearConfig.apiKeyEnv}`,
            code: 'LINEAR_API_KEY_NOT_FOUND',
          })
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(LINEAR_API_URL, {
              body: JSON.stringify({
                query: `query Issues($filter: IssueFilter!) {
  issues(filter: $filter, first: 100) {
    nodes {
      identifier
      title
    }
  }
}`,
                variables: {
                  filter: buildLinearFilter(parsedConfig.label, linearConfig),
                },
              }),
              headers: {
                Authorization: apiKey,
                'Content-Type': 'application/json',
              },
              method: 'POST',
            }),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? `Failed to fetch Linear issues: ${error.message}`
                  : `Failed to fetch Linear issues: ${String(error)}`,
              code: 'LINEAR_API_FAILED',
            }),
        })

        const responseBody = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () =>
            new RpcError({
              message: 'Linear API returned an invalid response body',
              code: 'LINEAR_API_INVALID_RESPONSE',
            }),
        })

        if (!response.ok) {
          const errorMessage =
            responseBody && typeof responseBody === 'object'
              ? String(responseBody)
              : response.statusText
          return yield* new RpcError({
            message: `Linear API request failed (${response.status}): ${errorMessage}`,
            code: 'LINEAR_API_FAILED',
          })
        }

        if (
          responseBody &&
          typeof responseBody === 'object' &&
          Reflect.has(responseBody, 'errors')
        ) {
          return yield* new RpcError({
            message: `Linear API errors: ${String(Reflect.get(responseBody, 'errors'))}`,
            code: 'LINEAR_API_FAILED',
          })
        }

        const issues = parseLinearIssues(responseBody)
        const existingExternalIds = new Set(
          store
            .query(tables.tasks.where('projectId', projectId))
            .filter(
              (task) => task.source === 'linear' && task.externalId !== null
            )
            .map((task) => task.externalId as string)
        )

        let importedCount = 0
        for (const issue of issues) {
          if (existingExternalIds.has(issue.identifier)) {
            continue
          }

          yield* taskManager.createTask(
            projectId,
            issue.title,
            'linear',
            issue.identifier
          )
          existingExternalIds.add(issue.identifier)
          importedCount += 1
        }

        return {
          importedCount,
          totalCount: issues.length,
        }
      })

      return LinearTaskImporter.of({
        importProjectIssues,
      })
    })
  )
}

export { LinearTaskImporter, parseRlphConfig }
export type { LinearIssuesResponse, ParsedRlphConfig }
