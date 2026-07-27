import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperatorStatusClient,
  type OperatorStatusView,
} from "../src/operator-status/client.ts";
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
});
