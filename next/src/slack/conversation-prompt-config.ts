import { Effect, Ref, Semaphore } from "effect";
import type {
  OpenCodeConversationPromptConfig,
  OpenCodeConversationPromptConfigLoader,
} from "../adapters/opencode-agents.ts";
import type { ReferenceCodingApplicationConfig } from "./laborer-config.ts";
import { loadLaborerConfig } from "./laborer-config.ts";

const promptConfigSnapshot = (
  config: ReferenceCodingApplicationConfig["conversation"]
): OpenCodeConversationPromptConfig =>
  Object.freeze(
    config === undefined
      ? {}
      : {
          instructions: Object.freeze([...config.instructions]),
          operationResultInstructions: Object.freeze([
            ...config.operationResultInstructions,
          ]),
        }
  );

export const makeHotReloadingConversationPromptConfig = Effect.fn(
  "makeHotReloadingConversationPromptConfig"
)(function* (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly initialConfig: ReferenceCodingApplicationConfig;
  readonly root: string;
}): Effect.fn.Return<OpenCodeConversationPromptConfigLoader> {
  const lastKnownGood = yield* Ref.make(
    promptConfigSnapshot(options.initialConfig.conversation)
  );
  const reloadSemaphore = Semaphore.makeUnsafe(1);
  const startupEnvironment = {
    ...options.environment,
    LABORER_ROOT: options.root,
  };

  const reload = Effect.fn("reloadConversationPromptConfig")(function* () {
    const loaded = yield* Effect.result(
      loadLaborerConfig({
        defaultRoot: options.root,
        environment: startupEnvironment,
      })
    );
    if (loaded._tag === "Failure") {
      yield* Effect.logWarning(
        "Conversation prompt configuration reload failed; retaining last known-good instructions",
        {
          operation: loaded.failure.operation,
          reason: loaded.failure.reason,
        }
      );
      return yield* Ref.get(lastKnownGood);
    }

    const application = loaded.success.config.application;
    if (application === undefined) {
      yield* Effect.logWarning(
        "Conversation prompt configuration reload ignored; application selection is startup-bound",
        { reason: "reference-coding-application-removed" }
      );
      return yield* Ref.get(lastKnownGood);
    }

    // Deliberately project only prompt fields. The workspace root, application
    // adapter, OpenCode client, model, agent, and environment stay startup-bound.
    const next = promptConfigSnapshot(application.conversation);
    yield* Ref.set(lastKnownGood, next);
    return next;
  });

  return () => reloadSemaphore.withPermit(reload());
});
