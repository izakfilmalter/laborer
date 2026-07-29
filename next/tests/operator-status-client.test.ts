import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
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
      projection: () => ({
        receiver: "connected",
        workspaces: [
          {
            detail: null,
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "ready",
            teamId: "TFIRST",
            threads: [],
          },
        ],
      }),
      tickIntervalMs: 60_000,
      version: "1.2.3",
    });
    servers.push(server);
    client.reconnect();

    const running = await waitForState(client, "running");
    expect(running).toEqual({
      receiver: "connected",
      state: "running",
      uptimeSeconds: 0,
      version: "1.2.3",
      workspaces: [
        {
          detail: null,
          id: "slack:TFIRST",
          label: "TFIRST",
          readiness: "ready",
          teamId: "TFIRST",
          threads: [],
        },
      ],
    });

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await waitForState(client, "reconnecting");
    await waitForState(client, "unavailable");

    server = await startOperatorStatusServer({
      now: () => 9000,
      paths,
      projection: () => ({
        receiver: "connected",
        workspaces: [
          {
            detail: "setup-required",
            id: "slack:TSECOND",
            label: "TSECOND",
            readiness: "setup-incomplete",
            teamId: "TSECOND",
            threads: [],
          },
        ],
      }),
      tickIntervalMs: 60_000,
      version: "1.2.4",
    });
    servers.push(server);
    client.reconnect();
    expect(await waitForState(client, "running")).toMatchObject({
      version: "1.2.4",
      workspaces: [
        expect.objectContaining({
          id: "slack:TSECOND",
          readiness: "setup-incomplete",
          threads: [],
        }),
      ],
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
        daemon: {
          receiver: "connected",
          startedAtUnixMs: 1000,
          version: "1.0.0",
        },
        kind: "snapshot",
        observedAtUnixMs: 2000 + index,
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        sequence: index + 1,
        workspaces: [],
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

  it("applies later live snapshots without reconnecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-live-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.token, "a".repeat(64), { mode: 0o600 });

    let publishNext = (): void => {
      throw new Error("client has not subscribed");
    };
    let confirmSubscription = (): void => undefined;
    const subscribed = new Promise<void>((resolveSubscription) => {
      confirmSubscription = resolveSubscription;
    });
    const snapshot = (sequence: number, observedAtUnixMs: number): string =>
      JSON.stringify({
        daemon: {
          receiver: "connected",
          startedAtUnixMs: 1000,
          version: "1.0.0",
        },
        kind: "snapshot",
        observedAtUnixMs,
        protocolVersion: OPERATOR_PROTOCOL_VERSION,
        sequence,
        workspaces: [],
      });
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.once("data", () => {
        socket.write(`${snapshot(1, 2000)}\n`);
        publishNext = () => socket.write(`${snapshot(2, 4000)}\n`);
        confirmSubscription();
      });
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
        uptimeSeconds: 1,
      });
      await subscribed;

      const updated = new Promise<OperatorStatusView>((resolveUpdated) => {
        const unsubscribe = client.subscribe((view) => {
          if (view.state === "running" && view.uptimeSeconds === 3) {
            unsubscribe();
            resolveUpdated(view);
          }
        });
      });
      publishNext();
      expect(await updated).toEqual({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 3,
        version: "1.0.0",
        workspaces: [],
      });
    } finally {
      for (const connection of connections) {
        connection.destroy();
      }
      await closeServer(server);
    }
  });

  it("stops reporting running when activity contains no complete snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-stalled-"));
    const paths = operatorStatusPaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.token, "a".repeat(64), { mode: 0o600 });
    const connections = new Set<Socket>();
    const activity = new Set<ReturnType<typeof setInterval>>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => {
        connections.delete(socket);
        for (const interval of activity) {
          clearInterval(interval);
        }
        activity.clear();
      });
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({
            daemon: {
              receiver: "connected",
              startedAtUnixMs: 1000,
              version: "1.0.0",
            },
            kind: "snapshot",
            observedAtUnixMs: 2000,
            protocolVersion: OPERATOR_PROTOCOL_VERSION,
            sequence: 1,
            workspaces: [],
          })}\n`
        );
        activity.add(setInterval(() => socket.write(" "), 10));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);

    try {
      const client = new OperatorStatusClient({
        paths,
        reconnectDelayMs: 60_000,
        snapshotTimeoutMs: 50,
      });
      clients.push(client);
      client.start();
      await waitForState(client, "running");
      await waitForState(client, "reconnecting");
    } finally {
      for (const interval of activity) {
        clearInterval(interval);
      }
      for (const connection of connections) {
        connection.destroy();
      }
      await closeServer(server);
    }
  });

  it.each([
    {
      expectedState: "incompatible" as const,
      record: JSON.stringify({
        daemon: {
          receiver: "connected",
          startedAtUnixMs: 1000,
          version: "2.0.0",
        },
        kind: "snapshot",
        observedAtUnixMs: 2000,
        protocolVersion: OPERATOR_PROTOCOL_VERSION + 1,
        sequence: 1,
        workspaces: [],
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

  it("fails closed when the daemon executable version is unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-operator-version-"));
    const paths = operatorStatusPaths(root);
    const server = await startOperatorStatusServer({
      paths,
      tickIntervalMs: 60_000,
      version: "0.0.0-older",
    });
    servers.push(server);
    const client = new OperatorStatusClient({
      expectedDaemonVersion: "0.1.0",
      paths,
      reconnectDelayMs: 60_000,
    });
    clients.push(client);
    client.start();

    await waitForState(client, "version-mismatch");
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
