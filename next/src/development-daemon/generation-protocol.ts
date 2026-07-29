import { Schema } from "effect";

export const DAEMON_GENERATION_PROTOCOL_VERSION = 1 as const;
export const MAX_DAEMON_GENERATION_IPC_BYTES = 4096;

const GenerationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
);

export const DaemonGenerationFailureReason = Schema.Literals([
  "activation-failed",
  "candidate-exited",
  "configuration-incompatible",
  "ipc-incompatible",
  "preparation-failed",
  "readiness-timeout",
  "runtime-incompatible",
  "stale-candidate",
  "stop-failed",
  "typecheck-failed",
  "workspace-regression",
]);
export type DaemonGenerationFailureReason =
  typeof DaemonGenerationFailureReason.Type;

export const DaemonGenerationCommand = Schema.Struct({
  command: Schema.Literals(["activate", "drain", "stop"]),
  generationId: GenerationId,
  protocolVersion: Schema.Literal(DAEMON_GENERATION_PROTOCOL_VERSION),
});
export type DaemonGenerationCommand = typeof DaemonGenerationCommand.Type;

export const DaemonGenerationReport = Schema.Struct({
  durationMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 86_400_000 })
  ),
  generationId: GenerationId,
  phase: Schema.Literals(["prepared", "active", "released", "failed"]),
  protocolVersion: Schema.Literal(DAEMON_GENERATION_PROTOCOL_VERSION),
  reason: Schema.optional(DaemonGenerationFailureReason),
  readyBindings: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 10_000 })
  ),
});
export type DaemonGenerationReport = typeof DaemonGenerationReport.Type;

export const encodeDaemonGenerationIpc = (record: unknown): string => {
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded, "utf8") > MAX_DAEMON_GENERATION_IPC_BYTES) {
    throw new Error("daemon generation IPC record exceeds its byte limit");
  }
  return encoded;
};

export const decodeDaemonGenerationCommand = Schema.decodeUnknownSync(
  DaemonGenerationCommand
);
export const decodeDaemonGenerationReport = Schema.decodeUnknownSync(
  DaemonGenerationReport
);
