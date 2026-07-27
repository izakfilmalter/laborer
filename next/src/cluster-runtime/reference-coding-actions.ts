import type { Effect } from "effect";
import {
  CreateFeatureActionInput,
  CreateFeatureActionResult,
  DealWithBugActionInput,
  DealWithBugActionResult,
} from "../action-catalog.ts";
import {
  defineRegisteredAction,
  makeRegisteredActionCatalog,
  type RegisteredActionContext,
} from "./registered-action.ts";

interface ReferenceCodingActionImplementations<CreateError, BugError> {
  readonly createFeature: (
    input: CreateFeatureActionInput,
    context: RegisteredActionContext
  ) => Effect.Effect<CreateFeatureActionResult, CreateError>;
  readonly dealWithBug: (
    input: DealWithBugActionInput,
    context: RegisteredActionContext
  ) => Effect.Effect<DealWithBugActionResult, BugError>;
}

const codingAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

/**
 * Compatibility registrations for the repository's example coding Actions.
 * The Cluster runtime sees these as ordinary user registrations and contains
 * no dispatch branch for either name.
 */
export const makeReferenceCodingActionCatalog = <CreateError, BugError>(
  implementations: ReferenceCodingActionImplementations<CreateError, BugError>
) =>
  makeRegisteredActionCatalog([
    defineRegisteredAction({
      annotations: codingAnnotations,
      description:
        "Implement a feature asynchronously in a new isolated named worktree.",
      input: CreateFeatureActionInput,
      name: "create-feature",
      result: CreateFeatureActionResult,
      revision: "reference-coding/create-feature/v1",
      run: implementations.createFeature,
    }),
    defineRegisteredAction({
      annotations: codingAnnotations,
      description:
        "Diagnose and fix a bug asynchronously in a new isolated named worktree.",
      input: DealWithBugActionInput,
      name: "deal-with-bug",
      result: DealWithBugActionResult,
      revision: "reference-coding/deal-with-bug/v1",
      run: implementations.dealWithBug,
    }),
  ]);
