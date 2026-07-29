import { chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeOperatorSnapshot,
  MAX_OPERATOR_RECORD_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  OperatorProtocolError,
} from "../src/operator-status/protocol.ts";
import {
  type OperatorStatusServer,
  operatorStatusPaths,
  startOperatorStatusServer,
} from "../src/operator-status/server.ts";

const servers: OperatorStatusServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const readFirstRecord = (
  socketPath: string,
  request: string
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let source = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk) => {
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline >= 0) {
        socket.destroy();
        resolve(source.slice(0, newline));
      }
    });
    socket.on("close", () => resolve(source));
    socket.on("error", reject);
  });

describe("operator status protocol", () => {
  it("bounds socket paths independently of the runtime root length", () => {
    const paths = operatorStatusPaths(
      join("/tmp", `laborer-${"nested-".repeat(20)}`)
    );

    expect(Buffer.byteLength(paths.socket, "utf8")).toBeLessThanOrEqual(96);
    expect(paths.token.startsWith(paths.directory)).toBe(true);
  });

  it("decodes a bounded versioned snapshot and rejects unsafe records", () => {
    const snapshot = decodeOperatorSnapshot(
      JSON.stringify({
        daemon: {
          receiver: "connected",
          startedAtUnixMs: 1000,
          version: "0.1.0",
        },
        kind: "snapshot",
        observedAtUnixMs: 4500,
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        sequence: 3,
        workspaces: [
          {
            detail: null,
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "ready",
            teamId: "TFIRST",
            threads: [
              {
                activity: "in-progress",
                id: "workspace:TFIRST:C123:1000.000001",
                label: "C123 · 1000.000001",
                stateChangedAtUnixMs: 4000,
                workspaceId: "TFIRST",
              },
            ],
          },
        ],
      })
    );

    expect(snapshot.daemon.version).toBe("0.1.0");
    expect(snapshot.sequence).toBe(3);
    expect(snapshot.workspaces[0]?.threads[0]?.activity).toBe("in-progress");
    expect(() =>
      decodeOperatorSnapshot(
        JSON.stringify({
          daemon: {
            receiver: "connected",
            startedAtUnixMs: 0,
            version: "0.1.0",
          },
          kind: "snapshot",
          observedAtUnixMs: 1,
          protocolVersion: OPERATOR_PROTOCOL_VERSION + 1,
          sequence: 1,
          workspaces: [],
        })
      )
    ).toThrowError(OperatorProtocolError);
    expect(() =>
      decodeOperatorSnapshot(
        JSON.stringify({
          ...snapshot,
          workspaces: [snapshot.workspaces[0], snapshot.workspaces[0]],
        })
      )
    ).toThrowError(OperatorProtocolError);
    expect(() =>
      decodeOperatorSnapshot(
        JSON.stringify({
          ...snapshot,
          workspaces: [
            {
              ...snapshot.workspaces[0],
              threads: [
                {
                  ...snapshot.workspaces[0]?.threads[0],
                  label: "private prompt or /Users/operator/secret",
                },
              ],
            },
          ],
        })
      )
    ).toThrowError(OperatorProtocolError);
    expect(() => decodeOperatorSnapshot("not-json")).toThrowError(
      OperatorProtocolError
    );
    expect(() =>
      decodeOperatorSnapshot(
        JSON.stringify({
          ...snapshot,
          workspaces: [
            {
              detail: "runtime-unavailable",
              id: "slack:TFIRST",
              label: "TFIRST",
              readiness: "ready",
              teamId: "TFIRST",
              threads: [],
            },
          ],
        })
      )
    ).toThrowError(OperatorProtocolError);
    expect(() =>
      decodeOperatorSnapshot("x".repeat(MAX_OPERATOR_RECORD_BYTES + 1))
    ).toThrowError(OperatorProtocolError);
  });

  it("serves live version and uptime only after owner-scoped authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-status-"));
    const paths = operatorStatusPaths(root);
    const server = await startOperatorStatusServer({
      now: () => 8000,
      paths,
      tickIntervalMs: 60_000,
      version: "0.1.0-test",
    });
    servers.push(server);

    const token = await readFile(paths.token, "utf8");
    const tokenMetadata = await stat(paths.token);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
    expect(tokenMetadata.mode & 0o077).toBe(0);

    const source = await readFirstRecord(
      paths.socket,
      JSON.stringify({
        kind: "subscribe",
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        token,
      })
    );
    const snapshot = decodeOperatorSnapshot(source);
    expect(snapshot.daemon.version).toBe("0.1.0-test");
    expect(snapshot.daemon.receiver).toBe("connecting");
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.observedAtUnixMs - snapshot.daemon.startedAtUnixMs).toBe(0);

    const unauthenticated = await readFirstRecord(
      paths.socket,
      JSON.stringify({
        kind: "subscribe",
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        token: "0".repeat(64),
      })
    );
    expect(unauthenticated).toBe("");
  });

  it("closes oversized clients without sending daemon state", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-bounds-"));
    const paths = operatorStatusPaths(root);
    const server = await startOperatorStatusServer({
      paths,
      tickIntervalMs: 60_000,
      version: "0.1.0-test",
    });
    servers.push(server);

    const response = await readFirstRecord(
      paths.socket,
      "x".repeat(MAX_OPERATOR_RECORD_BYTES + 1)
    );
    expect(response).toBe("");
  });

  it("fails closed when the status directory is not owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-scope-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await chmod(paths.directory, 0o755);

    await expect(
      startOperatorStatusServer({
        paths,
        tickIntervalMs: 60_000,
        version: "0.1.0-test",
      })
    ).rejects.toThrow("operator status directory is not owner-only");
  });

  it("bounds connections before they authenticate", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-clients-"));
    const paths = operatorStatusPaths(root);
    const server = await startOperatorStatusServer({
      paths,
      tickIntervalMs: 60_000,
      version: "0.1.0-test",
    });
    servers.push(server);

    const pending: Socket[] = [];
    try {
      for (let index = 0; index < 16; index += 1) {
        const socket = connect(paths.socket);
        socket.on("error", () => undefined);
        await new Promise<void>((resolveConnection) =>
          socket.once("connect", resolveConnection)
        );
        pending.push(socket);
      }

      const excess = connect(paths.socket);
      await new Promise<void>((resolveClosed, reject) => {
        excess.once("close", () => resolveClosed());
        excess.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") {
            resolveClosed();
          } else {
            reject(error);
          }
        });
      });
      expect(excess.destroyed).toBe(true);
    } finally {
      for (const socket of pending) {
        socket.destroy();
      }
    }
  });
});
