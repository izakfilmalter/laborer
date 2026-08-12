export type RecoveredSession =
  | { readonly status: "ambiguous" }
  | {
      readonly error: string;
      readonly errorType?: string;
      readonly status: "failed";
    }
  | { readonly status: "incomplete" }
  | { readonly status: "succeeded"; readonly text: readonly string[] };

export type RecoveryObservation =
  | { readonly type: "api_failure" }
  | { readonly type: "session_active" }
  | {
      readonly assistant?: Record<string, unknown>;
      readonly type: "session_inactive";
    };

export interface RecoveryPollContext {
  readonly apiFailingSinceMs?: number;
  readonly deadlineMs: number;
  readonly nowMs: number;
}

export type RecoveryDecision =
  | { readonly outcome: RecoveredSession; readonly type: "settled" }
  | { readonly apiFailingSinceMs?: number; readonly type: "wait" };

/**
 * The OpenCode service auto-updates itself in place (npm swaps the CLI
 * binary and the daemon restarts), which makes every `opencode2` spawn fail
 * for a short window. A recovery verdict of "ambiguous" aborts the whole
 * pipeline stage, so only give up after a sustained outage rather than a
 * fixed number of failed polls.
 */
export const API_OUTAGE_GRACE_MS = 10 * 60_000;

export const decideRecoveryStep = (
  observation: RecoveryObservation,
  context: RecoveryPollContext
): RecoveryDecision => {
  if (context.nowMs >= context.deadlineMs) {
    return { outcome: { status: "ambiguous" }, type: "settled" };
  }
  switch (observation.type) {
    case "api_failure": {
      const apiFailingSinceMs = context.apiFailingSinceMs ?? context.nowMs;
      if (context.nowMs - apiFailingSinceMs >= API_OUTAGE_GRACE_MS) {
        return { outcome: { status: "ambiguous" }, type: "settled" };
      }
      return { apiFailingSinceMs, type: "wait" };
    }
    case "session_active": {
      return { type: "wait" };
    }
    case "session_inactive": {
      const outcome =
        observation.assistant === undefined
          ? ({ status: "ambiguous" } as const)
          : classifyRecoveredAssistant(observation.assistant);
      if (outcome.status === "ambiguous") {
        // A restarting daemon reports an empty active list while it resumes
        // the interrupted turn, so a mid-flight assistant message here does
        // not mean the session is lost. The durable message log settles once
        // the resumed turn completes; keep waiting until the deadline.
        return { type: "wait" };
      }
      return { outcome, type: "settled" };
    }
  }
};

export const classifyRecoveredAssistant = (
  assistant: Record<string, unknown>
): RecoveredSession => {
  const completed =
    isRecord(assistant.time) && typeof assistant.time.completed === "number";
  if (!completed) {
    return { status: "ambiguous" };
  }

  const error = errorMessage(assistant.error);
  const errorType =
    isRecord(assistant.error) && typeof assistant.error.type === "string"
      ? assistant.error.type
      : undefined;
  if (error !== undefined) {
    return {
      error,
      ...(errorType === undefined ? {} : { errorType }),
      status: "failed",
    };
  }

  // OpenCode can durably complete an individual assistant message because it
  // hit an output limit or ended on a tool call while the overall task still
  // needs another turn. Sandcastle requires a final narrative and completion
  // marker, so a terminal tool-call step must also be continued.
  if (assistant.finish === "length" || assistant.finish === "tool-calls") {
    return { status: "incomplete" };
  }

  if (assistant.finish !== "stop") {
    const finish =
      typeof assistant.finish === "string" ? assistant.finish : "missing";
    return {
      error: `OpenCode assistant stopped with unsafe finish reason: ${finish}.`,
      status: "failed",
    };
  }

  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const text = content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : []
  );
  return { status: "succeeded", text };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const errorMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === "string") {
    return value.message;
  }
  return errorMessage(value.error);
};
