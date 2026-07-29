import { z } from "zod";

export const OPERATOR_PROTOCOL_VERSION = 1 as const;
export const MAX_OPERATOR_RECORD_BYTES = 4096;

const boundedVersion = z.string().trim().min(1).max(64);

const OperatorSnapshotSchema = z
  .object({
    daemon: z
      .object({
        startedAtUnixMs: z.number().int().nonnegative(),
        version: boundedVersion,
      })
      .strict(),
    kind: z.literal("snapshot"),
    observedAtUnixMs: z.number().int().nonnegative(),
    protocolVersion: z.literal(OPERATOR_PROTOCOL_VERSION),
    sequence: z.number().int().positive(),
  })
  .strict()
  .refine(
    (snapshot) => snapshot.observedAtUnixMs >= snapshot.daemon.startedAtUnixMs,
    "observation predates daemon start"
  );

export type OperatorSnapshot = z.infer<typeof OperatorSnapshotSchema>;

const OperatorSubscribeSchema = z
  .object({
    kind: z.literal("subscribe"),
    protocolVersion: z.literal(OPERATOR_PROTOCOL_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type OperatorSubscribe = z.infer<typeof OperatorSubscribeSchema>;

export class OperatorProtocolError extends Error {
  readonly reason: "incompatible" | "malformed" | "oversized";

  constructor(reason: "incompatible" | "malformed" | "oversized") {
    super(`Operator protocol record rejected: ${reason}`);
    this.name = "OperatorProtocolError";
    this.reason = reason;
  }
}

const parseBoundedJson = (source: string): unknown => {
  if (Buffer.byteLength(source, "utf8") > MAX_OPERATOR_RECORD_BYTES) {
    throw new OperatorProtocolError("oversized");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new OperatorProtocolError("malformed");
  }
};

const hasIncompatibleVersion = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "protocolVersion" in value &&
  value.protocolVersion !== OPERATOR_PROTOCOL_VERSION;

export const decodeOperatorSnapshot = (source: string): OperatorSnapshot => {
  const value = parseBoundedJson(source);
  if (hasIncompatibleVersion(value)) {
    throw new OperatorProtocolError("incompatible");
  }
  const result = OperatorSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new OperatorProtocolError("malformed");
  }
  return result.data;
};

export const decodeOperatorSubscribe = (source: string): OperatorSubscribe => {
  const value = parseBoundedJson(source);
  if (hasIncompatibleVersion(value)) {
    throw new OperatorProtocolError("incompatible");
  }
  const result = OperatorSubscribeSchema.safeParse(value);
  if (!result.success) {
    throw new OperatorProtocolError("malformed");
  }
  return result.data;
};
