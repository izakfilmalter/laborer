/**
 * Shared workspace-creation flow.
 *
 * Owns everything both creation surfaces need — the inline sidebar composer and
 * the sub-workspace dialog: classifying the typed value as a branch name or a
 * Slack URL, planning a Slack workspace before creating it, reporting the
 * temporary sidebar item while the work is in flight, and opening the agent
 * once the workspace is ready.
 *
 * Presentation of success and failure is deliberately left to the caller: the
 * composer reports inline, the dialog reports with toasts.
 *
 * @see Issue #42: Create Workspace form
 * @see Issue #49: Workspace creation error display
 * @see Issue #121: Loading state — workspace creation
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import { pipe, String as Str } from 'effect'
import { useCallback, useId, useRef } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { usePanelActions } from '@/panels/panel-context'

const createWorkspaceMutation = LaborerClient.mutation('workspace.create')
const planSlackWorkspaceMutation = LaborerClient.mutation(
  'workspace.planFromSlack'
)

/** Characters the combined input accepts: branch-safe characters plus URL syntax. */
const ALLOWED_INPUT_PATTERN = /^[a-zA-Z0-9\s\-_/.:?=&#%~+@]*$/
const BRANCH_UNSAFE_PATTERN = /[^a-z0-9\-_/.]/g
const HTTP_SCHEME_PATTERN = /^https?:\/\//i
const URL_SCHEMES = ['https://', 'http://']
/** Below this length a value is still ambiguous with a branch name like "ht". */
const MIN_SCHEME_PREFIX_LENGTH = 4

/**
 * True when the value should be treated as a Slack URL rather than a branch
 * name. Partial schemes ("http", "https:/") count so that normalization stops
 * mangling the value while a URL is still being typed.
 */
const isSlackUrlInput = (value: string): boolean => {
  const candidate = value.trim().toLowerCase()
  if (candidate === '') {
    return false
  }
  return (
    HTTP_SCHEME_PATTERN.test(candidate) ||
    candidate.includes('slack.com') ||
    (candidate.length >= MIN_SCHEME_PREFIX_LENGTH &&
      URL_SCHEMES.some((scheme) => scheme.startsWith(candidate)))
  )
}

/** Slack URLs pasted without a scheme still need one for the planner. */
const toSlackUrl = (value: string): string =>
  HTTP_SCHEME_PATTERN.test(value) ? value : `https://${value}`

const toBranchName = (value: string): string =>
  pipe(
    value,
    Str.toLowerCase,
    Str.replaceAll(' ', '-'),
    Str.replace(BRANCH_UNSAFE_PATTERN, '')
  )

/**
 * What the typed value will become once committed. `unrecognized-link` is a
 * link the planner cannot read, called out before it is sent as one.
 */
type CreateWorkspaceIntent = 'branch' | 'empty' | 'slack' | 'unrecognized-link'

/** Classify the typed value the way the creation flow will treat it. */
const createWorkspaceIntent = (trimmed: string): CreateWorkspaceIntent => {
  if (trimmed.length === 0) {
    return 'empty'
  }
  if (!isSlackUrlInput(trimmed)) {
    return 'branch'
  }
  return isSlackMessageUrl(toSlackUrl(trimmed)) ? 'slack' : 'unrecognized-link'
}

type PendingWorkspaceCreationPhase = 'analyzing' | 'creating'

interface PendingWorkspaceCreation {
  readonly branchName: string | null
  readonly id: string
  readonly phase: PendingWorkspaceCreationPhase
}

type PendingWorkspaceCreationChangeHandler = (change: {
  readonly creation: PendingWorkspaceCreation | null
  readonly id: string
}) => void

interface CreateWorkspaceRequest {
  /**
   * When set, creates a sub-workspace: the new worktree branches from this
   * workspace's current HEAD and its PR targets its branch.
   */
  readonly baseWorkspaceId?: string | undefined
  /** Raw typed value — a branch name, a Slack URL, or empty to auto-name. */
  readonly branchNameOrSlackUrl: string
  /** Follows this submission's phase, for callers that label a submit button. */
  readonly onPhaseChange?:
    | ((phase: PendingWorkspaceCreationPhase | null) => void)
    | undefined
  readonly projectId: string
}

interface CreatedWorkspace {
  readonly branchName: string
  /** True when the branch name and prompt came from a Slack thread. */
  readonly fromSlack: boolean
  readonly id: string
}

/**
 * Returns the workspace creation call. It resolves once the server has accepted
 * the workspace (status `creating`); worktree setup continues in the background
 * and streams into the sidebar card. It rejects with the underlying failure so
 * the caller can present it however suits its surface.
 */
function useCreateWorkspace(
  onPendingCreationChange?: PendingWorkspaceCreationChangeHandler | undefined
) {
  const panelActions = usePanelActions()
  const pendingIdPrefix = useId()
  // Each submission gets its own pending id, so a composer left open can start
  // several creations without them overwriting each other's sidebar item.
  const submissionCountRef = useRef(0)
  const createWorkspace = useAtomSet(createWorkspaceMutation, {
    mode: 'promise',
  })
  const planSlackWorkspace = useAtomSet(planSlackWorkspaceMutation, {
    mode: 'promise',
  })

  return useCallback(
    async ({
      baseWorkspaceId,
      branchNameOrSlackUrl,
      onPhaseChange,
      projectId,
    }: CreateWorkspaceRequest): Promise<CreatedWorkspace> => {
      const entered = branchNameOrSlackUrl.trim()
      const slackUrl = isSlackUrlInput(entered) ? toSlackUrl(entered) : ''
      let branchName = slackUrl ? '' : entered
      let initialPrompt: string | undefined
      const initialPhase: PendingWorkspaceCreationPhase = slackUrl
        ? 'analyzing'
        : 'creating'

      submissionCountRef.current += 1
      const pendingId = `${pendingIdPrefix}-${submissionCountRef.current}`

      onPhaseChange?.(initialPhase)
      onPendingCreationChange?.({
        creation: {
          branchName: branchName || null,
          id: pendingId,
          phase: initialPhase,
        },
        id: pendingId,
      })

      try {
        if (slackUrl) {
          const plan = await planSlackWorkspace({ payload: { slackUrl } })
          branchName = plan.branchName
          initialPrompt = plan.initialPrompt
          onPendingCreationChange?.({
            creation: { branchName, id: pendingId, phase: 'creating' },
            id: pendingId,
          })
        }

        onPhaseChange?.('creating')
        const result = await createWorkspace({
          payload: {
            operationId: crypto.randomUUID(),
            projectId,
            ...(branchName ? { branchName } : {}),
            ...(baseWorkspaceId ? { baseWorkspaceId } : {}),
          },
        })

        if (initialPrompt === undefined) {
          panelActions?.autoOpenAgentWhenWorkspaceReady?.(result.id)
        } else {
          panelActions?.autoOpenAgentWhenWorkspaceReady?.(result.id, {
            initialPrompt,
          })
        }

        return {
          branchName: result.branchName,
          fromSlack: slackUrl !== '',
          id: result.id,
        }
      } finally {
        onPendingCreationChange?.({ creation: null, id: pendingId })
        onPhaseChange?.(null)
      }
    },
    [
      createWorkspace,
      onPendingCreationChange,
      panelActions,
      pendingIdPrefix,
      planSlackWorkspace,
    ]
  )
}

export {
  ALLOWED_INPUT_PATTERN,
  createWorkspaceIntent,
  isSlackUrlInput,
  toBranchName,
  toSlackUrl,
  useCreateWorkspace,
}
export type {
  CreatedWorkspace,
  CreateWorkspaceIntent,
  CreateWorkspaceRequest,
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
  PendingWorkspaceCreationPhase,
}
