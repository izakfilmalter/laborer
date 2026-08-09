import { createHash } from "node:crypto";
import {
  canonicalCatalogJson,
  productionActionCatalog,
} from "./action-catalog.ts";
import { productionExecutionControlCatalog } from "./execution-control-catalog.ts";

export interface GeneratedActionCatalogProjection {
  readonly fingerprint: string;
  readonly tools: readonly {
    readonly annotations: {
      readonly destructiveHint: boolean;
      readonly idempotentHint: boolean;
      readonly openWorldHint: boolean;
      readonly readOnlyHint: boolean;
    };
    readonly description: string;
    readonly inputSchema: import("effect/JsonSchema").JsonSchema;
    readonly name: string;
    readonly outputSchema: import("effect/JsonSchema").JsonSchema;
  }[];
}

export const makeGeneratedMutationCatalog = (
  actionCatalog: GeneratedActionCatalogProjection
) => {
  const tools = [
    ...actionCatalog.tools,
    ...productionExecutionControlCatalog.tools,
  ].sort((left, right) => left.name.localeCompare(right.name));

  return {
    actionFingerprint: actionCatalog.fingerprint,
    contractVersion: 1,
    controlFingerprint: productionExecutionControlCatalog.fingerprint,
    fingerprint: createHash("sha256")
      .update("laborer-generated-mutation-catalog-v1\0", "utf8")
      .update(
        canonicalCatalogJson({
          actionCatalog: actionCatalog.fingerprint,
          contractVersion: 1,
          executionControlCatalog:
            productionExecutionControlCatalog.fingerprint,
          tools,
        }),
        "utf8"
      )
      .digest("base64url"),
    tools,
  } as const;
};

export const productionGeneratedMutationCatalog = makeGeneratedMutationCatalog(
  productionActionCatalog
);
