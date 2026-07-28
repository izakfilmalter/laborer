import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { defineApplication } from "./action.ts";
import { legacyRuntimeRootForDatabase } from "./legacy-import.ts";
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
} from "./root-runtime.ts";

const conversationOnlyApplication = defineApplication({ actions: [] });
export const CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT =
  conversationOnlyApplication.actions.fingerprint;

export const makeNodeRootDurableRuntime = Effect.fn(
  "makeNodeRootDurableRuntime"
)(function* (options: {
  readonly databasePath: string;
  readonly legacyWorkspaceId?: string;
  readonly rootIdentity: string;
}): Effect.fn.Return<
  RootDurableRuntimeShape,
  unknown,
  import("effect").Scope.Scope
> {
  const context = yield* Layer.build(
    makeRootDurableRuntimeLayer(
      makeSqliteLayer({ filename: options.databasePath }),
      conversationOnlyApplication.actions,
      options.rootIdentity,
      legacyRuntimeRootForDatabase(options.databasePath),
      options.legacyWorkspaceId
    )
  );
  return yield* RootDurableRuntime.pipe(Effect.provide(context));
});
