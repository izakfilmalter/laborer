import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import {
  decodeOperatorSnapshot,
  MAX_OPERATOR_RECORD_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  OperatorProtocolError,
} from "./protocol.ts";
import type { OperatorStatusPaths } from "./server.ts";

export type OperatorStatusView =
  | {
      readonly state: "connecting" | "reconnecting";
      readonly uptimeSeconds: null;
      readonly version: null;
    }
  | {
      readonly state: "running";
      readonly uptimeSeconds: number;
      readonly version: string;
    }
  | {
      readonly state: "incompatible" | "unavailable";
      readonly uptimeSeconds: null;
      readonly version: null;
    };

type OperatorStatusListener = (view: OperatorStatusView) => void;
const AUTHENTICATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const initialView: OperatorStatusView = {
  state: "connecting",
  uptimeSeconds: null,
  version: null,
};

const readOwnerToken = async (path: string): Promise<string> => {
  const handle = await open(
    path,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are masks.
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat();
    const userId =
      typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !metadata.isFile() ||
      (userId !== null && metadata.uid !== userId) ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
      (metadata.mode & 0o077) !== 0 ||
      metadata.size !== 64
    ) {
      throw new Error("unsafe operator authentication token");
    }
    const token = await handle.readFile("utf8");
    if (!AUTHENTICATION_TOKEN_PATTERN.test(token)) {
      throw new Error("malformed operator authentication token");
    }
    return token;
  } finally {
    await handle.close();
  }
};

export class OperatorStatusClient {
  readonly #listeners = new Set<OperatorStatusListener>();
  readonly #paths: OperatorStatusPaths;
  readonly #reconnectDelayMs: number;
  #closed = false;
  #connectedOnce = false;
  #connectGeneration = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: Socket | null = null;
  #view: OperatorStatusView = initialView;

  constructor(options: {
    readonly paths: OperatorStatusPaths;
    readonly reconnectDelayMs?: number;
  }) {
    this.#paths = options.paths;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  start(): void {
    if (
      !this.#closed &&
      this.#socket === null &&
      this.#reconnectTimer === null
    ) {
      this.#launchConnect();
    }
  }

  reconnect(): void {
    if (this.#closed) {
      return;
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.destroy();
    this.#socket = null;
    this.#setView({
      state: this.#connectedOnce ? "reconnecting" : "connecting",
      uptimeSeconds: null,
      version: null,
    });
    this.#launchConnect();
  }

  close(): void {
    this.#closed = true;
    this.#connectGeneration += 1;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.destroy();
    this.#socket = null;
    this.#listeners.clear();
  }

  subscribe(listener: OperatorStatusListener): () => void {
    this.#listeners.add(listener);
    listener(this.#view);
    return () => this.#listeners.delete(listener);
  }

  #setView(view: OperatorStatusView): void {
    this.#view = view;
    for (const listener of this.#listeners) {
      listener(view);
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) {
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#setView({
        state: this.#connectedOnce ? "reconnecting" : "connecting",
        uptimeSeconds: null,
        version: null,
      });
      this.#launchConnect();
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref?.();
  }

  #launchConnect(): void {
    const generation = ++this.#connectGeneration;
    this.#connect(generation).catch(() => {
      if (!this.#closed && generation === this.#connectGeneration) {
        this.#setView({
          state: "unavailable",
          uptimeSeconds: null,
          version: null,
        });
        this.#scheduleReconnect();
      }
    });
  }

  async #connect(generation: number): Promise<void> {
    if (
      this.#closed ||
      generation !== this.#connectGeneration ||
      this.#socket !== null
    ) {
      return;
    }
    let token: string;
    try {
      token = await readOwnerToken(this.#paths.token);
    } catch {
      if (this.#closed || generation !== this.#connectGeneration) {
        return;
      }
      this.#setView({
        state: "unavailable",
        uptimeSeconds: null,
        version: null,
      });
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed || generation !== this.#connectGeneration) {
      return;
    }

    const socket = connect(this.#paths.socket);
    this.#socket = socket;
    let settled = false;
    let source = Buffer.alloc(0);
    let lastSequence = 0;
    const isCurrentConnection = (): boolean =>
      !this.#closed &&
      generation === this.#connectGeneration &&
      this.#socket === socket;
    const fail = (state: "incompatible" | "unavailable"): void => {
      if (settled || !isCurrentConnection()) {
        socket.destroy();
        return;
      }
      settled = true;
      socket.destroy();
      if (this.#socket === socket) {
        this.#socket = null;
      }
      this.#setView({ state, uptimeSeconds: null, version: null });
      if (state !== "incompatible") {
        this.#scheduleReconnect();
      }
    };

    socket.setTimeout(3000, () => fail("unavailable"));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          kind: "subscribe",
          protocolVersion: OPERATOR_PROTOCOL_VERSION,
          token,
        })}\n`
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (!isCurrentConnection()) {
        socket.destroy();
        return;
      }
      let remaining = chunk;
      let newline = remaining.indexOf(0x0a);
      while (newline >= 0) {
        if (source.byteLength + newline > MAX_OPERATOR_RECORD_BYTES) {
          fail("unavailable");
          return;
        }
        const record = Buffer.concat([
          source,
          remaining.subarray(0, newline),
        ]).toString("utf8");
        source = Buffer.alloc(0);
        remaining = remaining.subarray(newline + 1);
        try {
          const snapshot = decodeOperatorSnapshot(record);
          if (snapshot.sequence <= lastSequence) {
            fail("unavailable");
            return;
          }
          lastSequence = snapshot.sequence;
          settled = false;
          socket.setTimeout(0);
          this.#connectedOnce = true;
          this.#setView({
            state: "running",
            uptimeSeconds: Math.floor(
              (snapshot.observedAtUnixMs - snapshot.daemon.startedAtUnixMs) /
                1000
            ),
            version: snapshot.daemon.version,
          });
        } catch (error) {
          fail(
            error instanceof OperatorProtocolError &&
              error.reason === "incompatible"
              ? "incompatible"
              : "unavailable"
          );
          return;
        }
        newline = remaining.indexOf(0x0a);
      }
      if (
        source.byteLength + remaining.byteLength >
        MAX_OPERATOR_RECORD_BYTES
      ) {
        fail("unavailable");
        return;
      }
      source = Buffer.concat([source, remaining]);
    });
    socket.once("error", () => fail("unavailable"));
    socket.once("close", () => {
      if (this.#closed || this.#socket !== socket) {
        return;
      }
      this.#socket = null;
      if (!settled) {
        this.#setView({
          state: this.#connectedOnce ? "reconnecting" : "unavailable",
          uptimeSeconds: null,
          version: null,
        });
        this.#scheduleReconnect();
      }
    });
  }
}
