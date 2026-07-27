import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_WAIT_MILLIS = 15_000;

export type FakeOpenAiReply =
  | {
      readonly finishReason?: "content_filter" | "length" | "stop";
      readonly kind: "text";
      readonly text?: string;
      readonly textChunks?: readonly string[];
    }
  | {
      readonly input: Readonly<Record<string, unknown>>;
      readonly kind: "tool";
      readonly name: string;
    }
  | {
      readonly kind: "hang";
      readonly textChunks?: readonly string[];
    };

export interface FakeOpenAiRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly path: string;
}

export interface FakeOpenAiProvider {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly enqueue: (...replies: readonly FakeOpenAiReply[]) => void;
  readonly requests: readonly FakeOpenAiRequest[];
  readonly waitForRequestCount: (
    expectedCount: number,
    timeoutMillis?: number
  ) => Promise<void>;
}

export interface FakeOpenAiProviderOptions {
  readonly selectReply?: (request: unknown) => FakeOpenAiReply | undefined;
}

const completionChunk = (input: {
  readonly delta?: Readonly<Record<string, unknown>>;
  readonly finishReason?: string;
}): Readonly<Record<string, unknown>> => ({
  choices: [
    {
      delta: input.delta ?? {},
      ...(input.finishReason === undefined
        ? {}
        : { finish_reason: input.finishReason }),
      index: 0,
    },
  ],
  created: 1_700_000_000,
  id: "chatcmpl-laborer-permission-policy",
  model: "permission-policy-model",
  object: "chat.completion.chunk",
});

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += data.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("fake provider request exceeded its byte limit");
    }
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const isTitleRequest = (body: unknown): boolean =>
  JSON.stringify(body).includes("Generate a title for this conversation");

const writeReply = (response: ServerResponse, reply: FakeOpenAiReply): void => {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.write(sse(completionChunk({ delta: { role: "assistant" } })));
  if (reply.kind === "tool") {
    response.write(
      sse(
        completionChunk({
          delta: {
            tool_calls: [
              {
                function: { arguments: "", name: reply.name },
                id: "call_laborer_permission_policy",
                index: 0,
                type: "function",
              },
            ],
          },
        })
      )
    );
    response.write(
      sse(
        completionChunk({
          delta: {
            tool_calls: [
              {
                function: { arguments: JSON.stringify(reply.input) },
                index: 0,
              },
            ],
          },
        })
      )
    );
    response.write(sse(completionChunk({ finishReason: "tool_calls" })));
    response.end("data: [DONE]\n\n");
    return;
  }
  for (const text of reply.textChunks ??
    (reply.kind === "text" && reply.text !== undefined ? [reply.text] : [])) {
    response.write(sse(completionChunk({ delta: { content: text } })));
  }
  if (reply.kind === "hang") {
    return;
  }
  response.write(
    sse(completionChunk({ finishReason: reply.finishReason ?? "stop" }))
  );
  response.end("data: [DONE]\n\n");
};

export const startFakeOpenAiProvider = async (
  options: FakeOpenAiProviderOptions = {}
): Promise<FakeOpenAiProvider> => {
  const replies: FakeOpenAiReply[] = [];
  const requests: FakeOpenAiRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const body = await readBody(request);
      requests.push({
        authorization: request.headers.authorization,
        body,
        path: request.url,
      });
      if (isTitleRequest(body)) {
        writeReply(response, { kind: "text", text: "Permission Policy" });
        return;
      }
      const reply = options.selectReply?.(body) ?? replies.shift();
      if (reply === undefined) {
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "no fake reply queued" } }));
        return;
      }
      writeReply(response, reply);
    };
    handle().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({ error: { message: "fake provider failed" } })
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((cause) => {
          if (cause === undefined) {
            resolveClose();
          } else {
            rejectClose(cause);
          }
        });
      }),
    enqueue: (...queued) => replies.push(...queued),
    requests,
    waitForRequestCount: async (
      expectedCount,
      timeoutMillis = DEFAULT_WAIT_MILLIS
    ) => {
      const deadline = Date.now() + timeoutMillis;
      while (requests.length < expectedCount && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (requests.length < expectedCount) {
        throw new Error(
          `timed out waiting for fake provider request ${expectedCount}; observed ${requests.length}`
        );
      }
    },
  };
};
