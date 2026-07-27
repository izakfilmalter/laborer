import { mkdtemp, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeOperatorSnapshot,
  MAX_OPERATOR_RECORD_BYTES,
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
  it("decodes a bounded versioned snapshot and rejects unsafe records", () => {
    const snapshot = decodeOperatorSnapshot(
      JSON.stringify({
        daemon: {
          startedAtUnixMs: 1000,
          version: "0.1.0",
        },
        kind: "snapshot",
        observedAtUnixMs: 4500,
        protocolVersion: 1,
        sequence: 3,
      })
    );

    expect(snapshot.daemon.version).toBe("0.1.0");
    expect(snapshot.sequence).toBe(3);
    expect(() =>
      decodeOperatorSnapshot(
        JSON.stringify({
          daemon: { startedAtUnixMs: 0, version: "0.1.0" },
          kind: "snapshot",
          observedAtUnixMs: 1,
          protocolVersion: 2,
          sequence: 1,
        })
      )
    ).toThrowError(OperatorProtocolError);
    expect(() => decodeOperatorSnapshot("not-json")).toThrowError(
      OperatorProtocolError
    );
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
        protocolVersion: 1,
        token,
      })
    );
    const snapshot = decodeOperatorSnapshot(source);
    expect(snapshot.daemon.version).toBe("0.1.0-test");
    expect(snapshot.observedAtUnixMs - snapshot.daemon.startedAtUnixMs).toBe(0);

    const unauthenticated = await readFirstRecord(
      paths.socket,
      JSON.stringify({
        kind: "subscribe",
        protocolVersion: 1,
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
});
