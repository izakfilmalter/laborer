import { createHash } from "node:crypto";
import {
  canonicalCatalogJson,
  productionActionCatalog,
} from "./action-catalog.ts";
import { productionExecutionControlCatalog } from "./execution-control-catalog.ts";

const tools = [
  ...productionActionCatalog.tools,
  ...productionExecutionControlCatalog.tools,
].sort((left, right) => left.name.localeCompare(right.name));

export const productionGeneratedMutationCatalog = {
  actionFingerprint: productionActionCatalog.fingerprint,
  contractVersion: 1,
  controlFingerprint: productionExecutionControlCatalog.fingerprint,
  fingerprint: createHash("sha256")
    .update("laborer-generated-mutation-catalog-v1\0", "utf8")
    .update(
      canonicalCatalogJson({
        actionCatalog: productionActionCatalog.fingerprint,
        contractVersion: 1,
        executionControlCatalog: productionExecutionControlCatalog.fingerprint,
        tools,
      }),
      "utf8"
    )
    .digest("base64url"),
  tools,
} as const;
