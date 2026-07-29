/**
 * Slack-facing copy for the ambiguous in-flight prompt recovery flow.
 *
 * These operational notices are the only public surface of that flow, so they
 * are written for the humans reading the work thread rather than for operators
 * reading state files. Each notice keeps the same shape: a bold status headline,
 * one sanitized explanation of what is queued, and — while the decision is still
 * open — the two choices an operator can make. They never carry prompt contents,
 * identifiers, arguments, paths, or private reasoning.
 */
export type RecoveryNoticeKind = "abandon" | "blocked" | "retry";

const BLOCKED_NOTICE = [
  "*Paused — an operator decision is needed.*",
  "An earlier agent turn ended with an uncertain external outcome, so Laborer stopped instead of guessing. Later messages, permission answers, and Execution updates stay queued in order behind it; nothing is lost.",
  "",
  "An operator resolves it from the local recovery CLI, in one of two ways:",
  "• *Abandon* — drop the uncertain attempt and continue in a replacement agent session.",
  "• *Retry* — rerun the attempt in a replacement agent session, after acknowledging that external side effects may be duplicated.",
  "",
  "This work thread resumes on its own once one decision is recorded.",
].join("\n");

const ABANDONED_NOTICE = [
  "*Resumed — the uncertain attempt was abandoned.*",
  "An operator dropped the uncertain agent turn, and this work thread continues in a replacement agent session. Queued messages, permission answers, and Execution updates are running again in the order they arrived.",
].join("\n");

const RETRY_NOTICE = [
  "*Resumed — the uncertain attempt was retried.*",
  "An operator acknowledged that external side effects may be duplicated and reran the uncertain agent turn in a replacement agent session. Queued messages, permission answers, and Execution updates continue once that retry finishes.",
].join("\n");

export const RECOVERY_NOTICE_TEXT: Readonly<
  Record<RecoveryNoticeKind, string>
> = {
  abandon: ABANDONED_NOTICE,
  blocked: BLOCKED_NOTICE,
  retry: RETRY_NOTICE,
};

export const recoveryNoticeText = (kind: RecoveryNoticeKind): string =>
  RECOVERY_NOTICE_TEXT[kind];
