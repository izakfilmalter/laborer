/**
 * The model writes the commit message and the pull request description.
 *
 * "Commit, push & PR" is one button because the operator has already made the
 * decision the words would only restate: they reviewed the diff and decided to
 * ship it. Asking them to also narrate it turns a single click into a writing
 * task, so the diff itself is handed to a model and the prose comes back.
 *
 * This module is deliberately all prompt and parse, no process and no git: the
 * caller gathers the context it needs from the worktree, and the generation
 * here stays a pure function of that context plus the operator's style
 * preference. That keeps the prompts testable without a repository.
 *
 * @see packages/shared/src/source-control-writing.ts — the style setting
 * @see workspace-sync-service.ts — gathers the git context and runs the steps
 */

import { RpcError } from '@laborer/shared/rpc'
import type { SourceControlWritingSettings } from '@laborer/shared/source-control-writing'
import { Effect } from 'effect'
import { runOpenCodePrompt, stripJsonCodeFence } from './opencode-runner.js'

/**
 * Writing a paragraph about a diff is a far shorter errand than reading a
 * Slack thread, and it sits in front of a button the operator is watching, so
 * it gets a much tighter deadline than the planner's three minutes.
 */
const GENERATION_TIMEOUT_MS = 90_000

const COMMIT_SUBJECT_MAX_LENGTH = 72
const CUSTOM_INSTRUCTIONS_LIMIT = 4000
const PR_TEMPLATE_LIMIT = 8000
const COMMIT_SUMMARY_LIMIT = 6000
const COMMIT_PATCH_LIMIT = 40_000
const PR_COMMITS_LIMIT = 12_000
const PR_DIFF_SUMMARY_LIMIT = 12_000
const PR_DIFF_PATCH_LIMIT = 40_000

const TRAILING_PERIODS_PATTERN = /\.+$/u
const NEWLINE_PATTERN = /\r?\n/u

/** The commit subject used when the model returns nothing usable. */
const FALLBACK_COMMIT_SUBJECT = 'Update project files'
/** The pull request title used when the model returns nothing usable. */
const FALLBACK_PR_TITLE = 'Update project changes'

/**
 * Where a repository keeps its pull request template.
 *
 * Ordered by how specific the location is, so a `.github/` template wins over
 * a root-level one when a repository has both.
 */
const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
] as const

/** Style instructions, resolved from the operator's preference. */
interface WritingPolicy {
  readonly commitInstructions: string
  readonly prInstructions: string
}

interface CommitMessage {
  readonly body: string
  readonly subject: string
}

interface PrContent {
  readonly body: string
  readonly title: string
}

interface CommitPromptContext {
  readonly branch: string | null
  readonly policy: WritingPolicy
  readonly stagedPatch: string
  readonly stagedSummary: string
}

interface PrPromptContext {
  readonly baseBranch: string
  readonly commitSummary: string
  readonly diffPatch: string
  readonly diffSummary: string
  readonly headBranch: string
  readonly policy: WritingPolicy
  readonly prTemplate: string | null
}

const limitSection = (value: string, maximum: number): string => {
  const trimmed = value.trim()
  return trimmed.length <= maximum
    ? trimmed
    : `${trimmed.slice(0, maximum)}\n\n[truncated]`
}

/**
 * Turn the operator's style preference into instructions the prompt can carry.
 *
 * `repo_conventions` needs the repository to speak for itself, so the caller
 * supplies recent commit subjects; with none — a fresh repository — the
 * instruction degrades to a plain request to follow local style rather than
 * inventing examples.
 */
const resolveWritingPolicy = (
  settings: SourceControlWritingSettings,
  recentCommitSubjects: readonly string[]
): WritingPolicy => {
  if (settings.mode === 'conventional_commits') {
    return {
      commitInstructions:
        'Use Conventional Commits for the subject. Prefer the narrowest accurate type, and include a scope only when the diff makes it obvious.',
      prInstructions:
        'Keep the title concise. Do not force Conventional Commit syntax into the title unless the repository already uses it.',
    }
  }

  if (settings.mode === 'custom') {
    const instructions = limitSection(
      settings.customInstructions,
      CUSTOM_INSTRUCTIONS_LIMIT
    )
    return { commitInstructions: instructions, prInstructions: instructions }
  }

  const base = "Follow the repository's established writing style."
  if (recentCommitSubjects.length === 0) {
    return { commitInstructions: base, prInstructions: base }
  }

  const examples = [
    'Recent commit subjects from this repository:',
    ...recentCommitSubjects,
  ].join('\n')
  return {
    commitInstructions: `${base}\n\n${examples}`,
    prInstructions: `${base}\n\n${examples}`,
  }
}

const instructionSection = (instructions: string): readonly string[] => {
  const trimmed = instructions.trim()
  return trimmed === '' ? [] : ['', 'Additional instructions:', trimmed]
}

const buildCommitMessagePrompt = ({
  branch,
  policy,
  stagedPatch,
  stagedSummary,
}: CommitPromptContext): string =>
  [
    'You write concise git commit messages.',
    'Return exactly one JSON object with keys: subject, body. No markdown, no commentary.',
    'Rules:',
    `- subject must be imperative, at most ${String(COMMIT_SUBJECT_MAX_LENGTH)} characters, and have no trailing period`,
    '- body can be an empty string or short bullet points',
    '- capture the primary user-visible or developer-visible change',
    '- describe only what the diff shows; never invent work that is not there',
    ...instructionSection(policy.commitInstructions),
    '',
    `Branch: ${branch ?? '(detached)'}`,
    '',
    'Staged files:',
    limitSection(stagedSummary, COMMIT_SUMMARY_LIMIT),
    '',
    'Staged patch:',
    limitSection(stagedPatch, COMMIT_PATCH_LIMIT),
  ].join('\n')

const buildPrContentPrompt = ({
  baseBranch,
  commitSummary,
  diffPatch,
  diffSummary,
  headBranch,
  policy,
  prTemplate,
}: PrPromptContext): string => {
  const template = prTemplate?.trim() ?? ''
  const bodyRules =
    template === ''
      ? [
          "- body must be markdown containing the headings '## Summary' and '## Testing'",
          '- under Summary, give short bullet points',
          "- under Testing, give bullet points with concrete checks, or 'Not run' where nothing was verified",
        ]
      : [
          "- body must be markdown following the repository's pull request template structure",
          '- fill in the template sections appropriately for this change',
          '- drop HTML comments from the template in the generated body',
          "- keep the template's markdown structure",
        ]

  return [
    'You write pull request titles and descriptions.',
    'Return exactly one JSON object with keys: title, body. No markdown fences, no commentary.',
    'Rules:',
    '- title should be concise and specific',
    ...bodyRules,
    '- describe only what the diff shows; never invent work that is not there',
    ...instructionSection(policy.prInstructions),
    ...(template === ''
      ? []
      : [
          '',
          'Repository pull request template:',
          limitSection(template, PR_TEMPLATE_LIMIT),
        ]),
    '',
    `Base branch: ${baseBranch}`,
    `Head branch: ${headBranch}`,
    '',
    'Commits:',
    limitSection(commitSummary, PR_COMMITS_LIMIT),
    '',
    'Diff stat:',
    limitSection(diffSummary, PR_DIFF_SUMMARY_LIMIT),
    '',
    'Diff patch:',
    limitSection(diffPatch, PR_DIFF_PATCH_LIMIT),
  ].join('\n')
}

/**
 * Trim a generated subject into something git and GitHub render well.
 *
 * A model that overruns the length or answers with a paragraph should still
 * produce a commit, so this narrows rather than rejects.
 */
const sanitizeCommitSubject = (value: string): string => {
  const firstLine = value.split(NEWLINE_PATTERN)[0]?.trim() ?? ''
  const withoutPeriod = firstLine.replace(TRAILING_PERIODS_PATTERN, '').trim()
  if (withoutPeriod === '') {
    return FALLBACK_COMMIT_SUBJECT
  }
  return withoutPeriod.length <= COMMIT_SUBJECT_MAX_LENGTH
    ? withoutPeriod
    : withoutPeriod.slice(0, COMMIT_SUBJECT_MAX_LENGTH).trimEnd()
}

const readJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(stripJsonCodeFence(text))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const parseCommitMessage = (text: string): CommitMessage | null => {
  const raw = readJsonObject(text)
  if (raw === null || typeof raw.subject !== 'string') {
    return null
  }
  return {
    body: typeof raw.body === 'string' ? raw.body.trim() : '',
    subject: sanitizeCommitSubject(raw.subject),
  }
}

const parsePrContent = (text: string): PrContent | null => {
  const raw = readJsonObject(text)
  if (raw === null || typeof raw.title !== 'string') {
    return null
  }
  const title = raw.title.split(NEWLINE_PATTERN)[0]?.trim() ?? ''
  return {
    body: typeof raw.body === 'string' ? raw.body.trim() : '',
    title: title === '' ? FALLBACK_PR_TITLE : title,
  }
}

/** The whole commit message, as `git commit -m` wants it. */
const renderCommitMessage = (message: CommitMessage): string =>
  message.body === ''
    ? message.subject
    : `${message.subject}\n\n${message.body}`

interface GenerationOptions {
  readonly cwd: string
  readonly model: string
  readonly prompt: string
}

const askModel = (
  { cwd, model, prompt }: GenerationOptions,
  failureCode: string,
  failureNoun: string
) =>
  Effect.tryPromise({
    try: (signal) =>
      runOpenCodePrompt({
        cwd,
        model,
        prompt,
        signal,
        timeoutMessage: `Timed out while writing the ${failureNoun}.`,
        timeoutMs: GENERATION_TIMEOUT_MS,
      }),
    catch: (error) =>
      new RpcError({
        code: failureCode,
        message: `Could not write the ${failureNoun}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

const generateCommitMessage = Effect.fn('generateCommitMessage')(function* (
  input: CommitPromptContext & { readonly cwd: string; readonly model: string }
) {
  const text = yield* askModel(
    {
      cwd: input.cwd,
      model: input.model,
      prompt: buildCommitMessagePrompt(input),
    },
    'COMMIT_MESSAGE_GENERATION_FAILED',
    'commit message'
  )

  const message = parseCommitMessage(text)
  if (message === null) {
    return yield* new RpcError({
      code: 'COMMIT_MESSAGE_GENERATION_FAILED',
      message:
        'The model did not return a usable commit message. Write one yourself from the Commit menu.',
    })
  }

  return renderCommitMessage(message)
})

const generatePrContent = Effect.fn('generatePrContent')(function* (
  input: PrPromptContext & { readonly cwd: string; readonly model: string }
) {
  const text = yield* askModel(
    { cwd: input.cwd, model: input.model, prompt: buildPrContentPrompt(input) },
    'PR_CONTENT_GENERATION_FAILED',
    'pull request description'
  )

  const content = parsePrContent(text)
  if (content === null) {
    return yield* new RpcError({
      code: 'PR_CONTENT_GENERATION_FAILED',
      message: 'The model did not return a usable pull request description.',
    })
  }

  return content
})

export {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  generateCommitMessage,
  generatePrContent,
  parseCommitMessage,
  parsePrContent,
  PR_TEMPLATE_PATHS,
  renderCommitMessage,
  resolveWritingPolicy,
  sanitizeCommitSubject,
}
export type { CommitMessage, PrContent, WritingPolicy }
