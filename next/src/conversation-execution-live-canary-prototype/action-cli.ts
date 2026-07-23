/** THROWAWAY ISSUE #217 CANARY — model-facing action CLI. */

import { createHash } from "node:crypto";
import { NodeSocket } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { ExecutionRpcs } from "./protocol.ts";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing injected canary environment: ${name}`);
  }
  return value;
};

const command = process.argv[2];
if (command !== "start" && command !== "get") {
  throw new Error("Usage: action-cli.ts <start|get>");
}

const socketPath = requiredEnvironment("LABORER_CANARY_SOCKET");
const threadId = requiredEnvironment("LABORER_CANARY_THREAD_ID");
const sourceEventId = requiredEnvironment("LABORER_CANARY_SOURCE_EVENT_ID");

const clientLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(NodeSocket.layerNet({ path: socketPath })),
  Layer.provide(RpcSerialization.layerNdjson)
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(ExecutionRpcs);
  if (command === "start") {
    const requestId = createHash("sha256")
      .update(`${threadId}\0${sourceEventId}\0static-canary-action`)
      .digest("hex");
    const result = yield* client.StartCanaryAction({ requestId, threadId });
    yield* Console.log(JSON.stringify(result));
    return;
  }
  const snapshot = yield* client.GetCurrentAction({ threadId });
  yield* Console.log(JSON.stringify(snapshot));
});

await Effect.runPromise(
  program.pipe(Effect.provide(clientLayer), Effect.scoped)
);
