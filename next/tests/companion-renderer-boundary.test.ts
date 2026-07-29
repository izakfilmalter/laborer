import { describe, expect, it } from "vitest";
import { isOperatorStatusView } from "../src/companion/shared.ts";

describe("companion renderer boundary", () => {
  it("accepts only the narrow validated status view model", () => {
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [],
      })
    ).toBe(true);
    expect(
      isOperatorStatusView({
        socketPath: "/private/operator.sock",
        receiver: "connected",
        state: "running",
        token: "secret",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [],
      })
    ).toBe(false);
    const visibleThread = {
      activity: "in-progress",
      executions: [
        {
          actionName: "fixture/build",
          id: "execution:stable",
          lifecycle: "allocated",
          startedAtUnixMs: 900,
          workThreadId: "workspace:TFIRST:C123:1000.000001",
          workspaceId: "TFIRST",
        },
      ],
      id: "workspace:TFIRST:C123:1000.000001",
      label: "C123 · 1000.000001",
      stateChangedAtUnixMs: 1000,
      workspaceId: "TFIRST",
    };
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [
          {
            detail: null,
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "ready",
            teamId: "TFIRST",
            threads: [visibleThread],
          },
        ],
      })
    ).toBe(true);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [
          {
            detail: null,
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "ready",
            teamId: "TFIRST",
            threads: [
              {
                ...visibleThread,
                executions: [
                  {
                    ...visibleThread.executions[0],
                    actionName: "prompt or /private/path",
                  },
                ],
              },
            ],
          },
        ],
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [
          {
            detail: null,
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "ready",
            teamId: "TFIRST",
            threads: [
              {
                ...visibleThread,
                label: "prompt, command, or /private/path",
              },
            ],
          },
        ],
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: Array.from({ length: 2 }, () => ({
          detail: null,
          id: "slack:TFIRST",
          label: "TFIRST",
          readiness: "ready",
          teamId: "TFIRST",
          threads: [],
        })),
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [
          {
            detail: "configuration-invalid",
            id: `binding:${"1".repeat(65)}`,
            label: `Workspace binding ${"1".repeat(65)}`,
            readiness: "unknown",
            teamId: null,
            threads: [],
          },
        ],
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        diagnostics: "connection refused at a private path",
        state: "unavailable",
        uptimeSeconds: null,
        version: null,
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: -1,
        version: "0.1.0",
        workspaces: [],
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        receiver: "connected",
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
        workspaces: [
          {
            detail: "raw provider failure at /private/root",
            id: "slack:TFIRST",
            label: "TFIRST",
            readiness: "unavailable",
            teamId: "TFIRST",
            threads: [],
          },
        ],
      })
    ).toBe(false);
    expect(
      isOperatorStatusView({
        state: "service-requires-approval",
        uptimeSeconds: null,
        version: null,
      })
    ).toBe(true);
    expect(
      isOperatorStatusView({
        diagnostics: "private service error",
        state: "service-denied",
        uptimeSeconds: null,
        version: null,
      })
    ).toBe(false);
  });
});
