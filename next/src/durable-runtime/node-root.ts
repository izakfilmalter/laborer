import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { defineApplication, type LaborerApplication } from "./action.ts";
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
  readonly application?: LaborerApplication;
  readonly rootIdentity: string;
}): Effect.fn.Return<
  RootDurableRuntimeShape,
  unknown,
  import("effect").Scope.Scope
> {
  const context = yield* Layer.build(
    makeRootDurableRuntimeLayer(
      makeSqliteLayer({ filename: options.databasePath }),
      options.application?.actions ?? conversationOnlyApplication.actions,
      options.rootIdentity
    )
  );
  return yield* RootDurableRuntime.pipe(Effect.provide(context));
});
