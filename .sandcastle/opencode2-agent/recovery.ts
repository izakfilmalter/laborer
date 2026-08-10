export type RecoveredSession =
  | { readonly status: "ambiguous" }
  | {
      readonly error: string;
      readonly errorType?: string;
      readonly status: "failed";
    }
  | { readonly status: "incomplete" }
  | { readonly status: "succeeded"; readonly text: readonly string[] };

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
