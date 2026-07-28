import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperatorStatusClient,
  type OperatorStatusView,
} from "../src/operator-status/client.ts";
import { OPERATOR_PROTOCOL_VERSION } from "../src/operator-status/protocol.ts";
import {
  type OperatorStatusServer,
  operatorStatusPaths,
  startOperatorStatusServer,
} from "../src/operator-status/server.ts";

const servers: OperatorStatusServer[] = [];
const clients: OperatorStatusClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const waitForState = (
  client: OperatorStatusClient,
  state: OperatorStatusView["state"]
): Promise<OperatorStatusView> =>
  new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${state}`));
    }, 2000);
    unsubscribe = client.subscribe((view) => {
      if (view.state === state) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(view);
      }
    });
  });

const startRecordServer = async (
  socketPath: string,
  record: string
): Promise<Server> => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(`${record}\n`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return server;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

describe("operator status client", () => {
  it("converges from unavailable to running and reconnects after daemon changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-client-"));
    const paths = operatorStatusPaths(root);
    const client = new OperatorStatusClient({ paths, reconnectDelayMs: 100 });
    clients.push(client);
    client.start();

    await waitForState(client, "unavailable");
    let server = await startOperatorStatusServer({
      now: () => 5000,
      paths,
      tickIntervalMs: 60_000,
      version: "1.2.3",
    });
    servers.push(server);
    client.reconnect();

    const running = await waitForState(client, "running");
    expect(running).toEqual({
      state: "running",
      uptimeSeconds: 0,
      version: "1.2.3",
    });

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await waitForState(client, "reconnecting");
    await waitForState(client, "unavailable");

    server = await startOperatorStatusServer({
      now: () => 9000,
      paths,
      tickIntervalMs: 60_000,
      version: "1.2.4",
    });
    servers.push(server);
    client.reconnect();
    expect(await waitForState(client, "running")).toMatchObject({
      version: "1.2.4",
    });
  });

  it("closing the observer does not stop the daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-lifetime-"));
    const paths = operatorStatusPaths(root);
    const server = await startOperatorStatusServer({
      paths,
      tickIntervalMs: 60_000,
      version: "1.0.0",
    });
    servers.push(server);
    const first = new OperatorStatusClient({ paths, reconnectDelayMs: 25 });
    clients.push(first);
    first.start();
    await waitForState(first, "running");
    first.close();

    const second = new OperatorStatusClient({ paths, reconnectDelayMs: 25 });
    clients.push(second);
    second.start();
    expect(await waitForState(second, "running")).toMatchObject({
      version: "1.0.0",
    });
  });

  it("accepts multiple bounded snapshots delivered in one network chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-batch-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await chmod(paths.directory, 0o700);
    const token = "a".repeat(64);
    await writeFile(paths.token, token, { mode: 0o600 });
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        daemon: { startedAtUnixMs: 1000, version: "1.0.0" },
        kind: "snapshot",
        observedAtUnixMs: 2000 + index,
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        sequence: index + 1,
      })
    ).join("\n");
    expect(Buffer.byteLength(snapshots, "utf8")).toBeGreaterThan(4096);

    const server = createServer((socket) => {
      socket.once("data", () => socket.end(`${snapshots}\n`));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    try {
      const client = new OperatorStatusClient({ paths });
      clients.push(client);
      client.start();
      expect(await waitForState(client, "running")).toMatchObject({
        version: "1.0.0",
      });
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    {
      expectedState: "incompatible" as const,
      record: JSON.stringify({
        daemon: { startedAtUnixMs: 1000, version: "2.0.0" },
        kind: "snapshot",
        observedAtUnixMs: 2000,
        protocolVersion: OPERATOR_PROTOCOL_VERSION + 1,
        sequence: 1,
      }),
    },
    { expectedState: "unavailable" as const, record: "not-json" },
  ])("fails closed as $expectedState for an invalid daemon record", async ({
    expectedState,
    record,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-invalid-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.token, "a".repeat(64), { mode: 0o600 });
    const server = await startRecordServer(paths.socket, record);
    try {
      const client = new OperatorStatusClient({
        paths,
        reconnectDelayMs: 60_000,
      });
      clients.push(client);
      client.start();
      await waitForState(client, expectedState);
    } finally {
      await closeServer(server);
    }
  });

  it("never sends authentication material through an unsafe status directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-unsafe-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.token, "a".repeat(64), { mode: 0o600 });
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    await chmod(paths.directory, 0o755);
    try {
      const client = new OperatorStatusClient({
        paths,
        reconnectDelayMs: 60_000,
      });
      clients.push(client);
      client.start();
      await waitForState(client, "unavailable");
      expect(connections).toBe(0);
    } finally {
      await closeServer(server);
    }
  });
});
