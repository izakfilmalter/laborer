/** THROWAWAY PROTOTYPE: scratch persistence for feeling out the CLI contract. */
import { Effect, FileSystem, Schema } from "effect";

export const PROTOTYPE_STATE_FILE =
  ".action-toolkit-prototype-state.json" as const;

const ExecutionStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const ExecutionRecord = Schema.Struct({
  action: Schema.String,
  error: Schema.NullOr(Schema.String),
  id: Schema.String,
  input: Schema.Unknown,
  progress: Schema.NullOr(Schema.Unknown),
  result: Schema.NullOr(Schema.Unknown),
  status: ExecutionStatus,
});
export type ExecutionRecord = typeof ExecutionRecord.Type;

const PrototypeState = Schema.Struct({
  executions: Schema.Array(ExecutionRecord),
  nextExecutionNumber: Schema.Number,
});
export type PrototypeState = typeof PrototypeState.Type;

const PrototypeStateJson = Schema.fromJsonString(PrototypeState);

export const emptyPrototypeState: PrototypeState = {
  executions: [],
  nextExecutionNumber: 1,
};

export const readPrototypeState = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(PROTOTYPE_STATE_FILE);
  if (!exists) {
    return emptyPrototypeState;
  }

  const encoded = yield* fileSystem.readFileString(PROTOTYPE_STATE_FILE);
  return yield* Schema.decodeUnknownEffect(PrototypeStateJson)(encoded);
});

export const writePrototypeState = (state: PrototypeState) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded =
      yield* Schema.encodeUnknownEffect(PrototypeStateJson)(state);
    yield* fileSystem.writeFileString(PROTOTYPE_STATE_FILE, encoded);
  });

export const resetPrototypeState = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(PROTOTYPE_STATE_FILE);
  if (exists) {
    yield* fileSystem.remove(PROTOTYPE_STATE_FILE);
  }
});
