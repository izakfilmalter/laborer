import { Effect } from "effect";
import { runAcpChatDaemon } from "../acp-runtime/chat-live.ts";

const DEFAULT_LABORER_ROOT = process.env.LABORER_ROOT ?? process.cwd();

await Effect.runPromise(
  runAcpChatDaemon(DEFAULT_LABORER_ROOT).pipe(Effect.scoped)
);
