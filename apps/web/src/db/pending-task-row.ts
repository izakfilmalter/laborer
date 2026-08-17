import type { SharedTaskRow } from '@laborer/shared/rpc'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'

/** The complete row optimistically inserted for a renderer-created Task. */
export const pendingTaskRow = (input: {
  readonly id: string
  readonly now: number
  readonly rootPath: string
  readonly status: Exclude<SharedTaskRow['status'], 'cancelled'>
  readonly text: string
}): SharedTaskRow => {
  const text = input.text.trim()
  const slackUrl = isSlackMessageUrl(text) ? new URL(text).toString() : null
  return {
    actionName: null,
    baseBranch: null,
    baseSha: null,
    branchName: null,
    createdAt: input.now,
    description: null,
    executionId: null,
    executionStatus: slackUrl === null ? null : 'queued',
    id: input.id,
    labelIds: [],
    parentTaskId: null,
    prBaseBranch: null,
    prCheckStatus: null,
    prChecks: null,
    prIsDraft: false,
    prMergeStatus: null,
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    revision: 1,
    rootPath: input.rootPath,
    setupCompletedAt: null,
    slackPermalink: slackUrl,
    sortOrder: null,
    source: slackUrl === null ? 'manual' : 'slack_url',
    status: input.status,
    taskNumber: 0,
    title: slackUrl ?? text,
    updatedAt: input.now,
    worktreeBotOwned: false,
    worktreeError: null,
    worktreeExists: false,
    worktreePath: null,
    worktreeStatus: null,
  }
}
