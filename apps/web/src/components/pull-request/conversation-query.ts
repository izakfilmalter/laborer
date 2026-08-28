import { RpcError } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { Atom } from 'effect/unstable/reactivity'
import { LaborerClient } from '@/atoms/laborer-client'

/** How long a single conversation read may take before it is abandoned. */
const COMMENTS_FETCH_TIMEOUT = '15 seconds'

/**
 * The live pull request conversation, shared by the side pane and card preview.
 *
 * Keeping one family here means a hover preview and an open pane reuse the same
 * in-flight read and cached result instead of each spending three GitHub API
 * requests for the same workspace.
 */
export const pullRequestConversationQuery = Atom.family((workspaceId: string) =>
  LaborerClient.runtime
    .atom(
      Effect.flatMap(LaborerClient, (client) =>
        client('pullRequest.comments', { workspaceId })
      ).pipe(
        Effect.timeoutOrElse({
          duration: COMMENTS_FETCH_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new RpcError({
                message: 'Timed out reading the pull request conversation',
                code: 'TIMEOUT',
              })
            ),
        })
      )
    )
    .pipe(Atom.setIdleTTL('1 minute'))
)
