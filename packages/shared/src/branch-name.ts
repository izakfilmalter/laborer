/**
 * Recognizing a pasted git branch name.
 *
 * Board composers take one line of free text that may be a card title, a Slack
 * permalink, or a branch name copied from someone else's pull request. Only the
 * last of those should reach git verbatim: a branch name typed exactly is what
 * lets workspace creation find it on `origin` and check the existing commits
 * out, instead of slugifying it into a new branch off HEAD.
 *
 * Whitespace is the discriminator. Titles read as prose and carry spaces;
 * branch names cannot contain them at all, so anything spaceless that also
 * satisfies git's ref rules is treated as a branch name.
 */

/** Longest text still considered a branch name rather than a title. */
const MAX_BRANCH_NAME_LENGTH = 200

/** Characters git refs may carry that a person would plausibly paste. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/+]*$/u

/** Sequences `git check-ref-format` rejects outright. */
const INVALID_REF_SEQUENCES = ['..', '//', '@{', '.lock/']

/**
 * The branch name this text names verbatim, or `null` when it reads as a title.
 *
 * Deliberately conservative: it never repairs the text. A value that comes back
 * non-null is safe to hand to `git fetch origin refs/heads/<name>` unchanged,
 * which is the whole point — a repaired name would no longer match origin.
 */
export const pastedBranchName = (value: string): string | null => {
  const candidate = value.trim()
  if (
    candidate.length === 0 ||
    candidate.length > MAX_BRANCH_NAME_LENGTH ||
    !BRANCH_NAME_PATTERN.test(candidate)
  ) {
    return null
  }
  if (candidate.endsWith('/') || candidate.endsWith('.lock')) {
    return null
  }
  if (INVALID_REF_SEQUENCES.some((sequence) => candidate.includes(sequence))) {
    return null
  }
  return candidate
}

/** True when the text names a branch verbatim. */
export const isPastedBranchName = (value: string): boolean =>
  pastedBranchName(value) !== null
