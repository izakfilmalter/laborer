/**
 * Reaction presentation and optimistic toggling, ported from t3code's
 * `pullRequestReactions.logic.ts`.
 *
 * Laborer adaptations: reaction contents are Laborer's camelCase literals,
 * and the contract carries no actor logins — only counts and whether the
 * viewer is among them — so the tooltip counts people rather than naming
 * them.
 */
import type {
  PullRequestReaction,
  PullRequestReactionContent,
} from '@laborer/shared/rpc'

/** The picker's order, which is GitHub's: the two verdicts first. */
export const PULL_REQUEST_REACTION_ORDER: readonly PullRequestReactionContent[] =
  [
    'thumbsUp',
    'thumbsDown',
    'laugh',
    'hooray',
    'confused',
    'heart',
    'rocket',
    'eyes',
  ]

const REACTION_EMOJI: Record<PullRequestReactionContent, string> = {
  thumbsUp: '👍',
  thumbsDown: '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
}

/** The spoken names GitHub uses in its own hover text. */
const REACTION_NAME: Record<PullRequestReactionContent, string> = {
  thumbsUp: 'thumbs up',
  thumbsDown: 'thumbs down',
  laugh: 'laugh',
  hooray: 'hooray',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
  eyes: 'eyes',
}

export function pullRequestReactionEmoji(
  content: PullRequestReactionContent
): string {
  return REACTION_EMOJI[content]
}

export function pullRequestReactionName(
  content: PullRequestReactionContent
): string {
  return REACTION_NAME[content]
}

/**
 * Who reacted, as a sentence. The contract names nobody, so the viewer
 * reads as "You" and everyone else is counted.
 */
export function pullRequestReactionTooltip(
  reaction: PullRequestReaction
): string {
  const others = Math.max(
    0,
    reaction.count - (reaction.viewerHasReacted ? 1 : 0)
  )
  const parts = [
    ...(reaction.viewerHasReacted ? ['You'] : []),
    ...(others > 0
      ? [
          reaction.viewerHasReacted
            ? `${others} ${others === 1 ? 'other' : 'others'}`
            : `${others} ${others === 1 ? 'person' : 'people'}`,
        ]
      : []),
  ]
  const names =
    parts.length === 2 ? `${parts[0]} and ${parts[1]}` : (parts[0] ?? '')
  return `${names} reacted with ${pullRequestReactionName(reaction.content)} emoji`
}

/**
 * The list as it should be drawn while a reaction is still in flight.
 * A pill that does not move until the re-read lands reads as a press
 * that did nothing.
 */
export function applyPendingPullRequestReactions(
  reactions: readonly PullRequestReaction[],
  pending: ReadonlyMap<PullRequestReactionContent, boolean>
): readonly PullRequestReaction[] {
  if (pending.size === 0) {
    return reactions
  }
  const byContent = new Map(
    reactions.map((reaction) => [reaction.content, reaction] as const)
  )
  for (const [content, reacted] of pending) {
    const current = byContent.get(content)
    if (current === undefined) {
      if (reacted) {
        byContent.set(content, { content, count: 1, viewerHasReacted: true })
      }
      continue
    }
    if (current.viewerHasReacted === reacted) {
      continue
    }
    const count = current.count + (reacted ? 1 : -1)
    if (count <= 0) {
      byContent.delete(content)
    } else {
      byContent.set(content, { ...current, count, viewerHasReacted: reacted })
    }
  }
  return PULL_REQUEST_REACTION_ORDER.flatMap(
    (content) => byContent.get(content) ?? []
  )
}
