/** THROWAWAY ISSUE #204 PROTOTYPE: typed, sanitized failure channels. */
import { Schema } from "effect";
import { HandlerFailureCategory, NormalizedMessage } from "./domain.ts";

export const DeliveryFailureDisposition = Schema.Literals([
  "transient",
  "item-permanent",
  "destination-permanent",
]);
export type DeliveryFailureDisposition = typeof DeliveryFailureDisposition.Type;

export class BoundaryDecodeError extends Schema.TaggedErrorClass<BoundaryDecodeError>()(
  "BoundaryDecodeError",
  { boundary: Schema.String, message: Schema.String }
) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()(
  "StoreError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class ReplyProtocolError extends Schema.TaggedErrorClass<ReplyProtocolError>()(
  "ReplyProtocolError",
  { reason: Schema.String }
) {}

export class ContextReadError extends Schema.TaggedErrorClass<ContextReadError>()(
  "ContextReadError",
  {
    category: Schema.String,
    isTransient: Schema.Boolean,
    partial: Schema.Array(NormalizedMessage),
  }
) {}

export class DeliveryError extends Schema.TaggedErrorClass<DeliveryError>()(
  "DeliveryError",
  {
    category: Schema.String,
    disposition: DeliveryFailureDisposition,
    outcomeCertainty: Schema.optional(
      Schema.Literals(["definitely-rejected", "unknown"])
    ),
    retryAfterMillis: Schema.Number,
  }
) {}

export class HandlerFailure extends Schema.TaggedErrorClass<HandlerFailure>()(
  "HandlerFailure",
  {
    category: HandlerFailureCategory,
    noticeStyle: Schema.optional(Schema.Literal("generic")),
    safeDetail: Schema.NullOr(Schema.String),
  }
) {}

export class EmulatorError extends Schema.TaggedErrorClass<EmulatorError>()(
  "EmulatorError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class ScenarioError extends Schema.TaggedErrorClass<ScenarioError>()(
  "ScenarioError",
  { operation: Schema.String }
) {}

export type RunnerError =
  | StoreError
  | ContextReadError
  | DeliveryError
  | HandlerFailure;
