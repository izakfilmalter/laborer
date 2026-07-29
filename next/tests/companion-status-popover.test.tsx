// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPopover } from "../src/companion/renderer/status-popover.tsx";

afterEach(cleanup);

const emptyBindingsPattern = /No workspace bindings are configured\./;

describe("companion status popover", () => {
  it("presents live daemon identity and uptime with an accessible hierarchy", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 3723,
          version: "0.1.0",
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
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "Laborer" })).toBeTruthy();
    expect(screen.getByText("Daemon running")).toBeTruthy();
    expect(screen.getByText("1h 2m")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "ready for Slack work"
    );
    expect(screen.getByText("1 connected")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "TFIRST" })).toBeTruthy();
    expect(
      screen.getByText("Connected and listening for Slack work.")
    ).toBeTruthy();
  });

  it("offers an explicit retry in unavailable and incompatible states", () => {
    const reconnect = vi.fn();
    const { rerender } = render(
      <StatusPopover
        quit={() => undefined}
        reconnect={reconnect}
        status={{ state: "unavailable", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.getByText("Daemon unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reconnect).toHaveBeenCalledOnce();

    rerender(
      <StatusPopover
        quit={() => undefined}
        reconnect={reconnect}
        status={{ state: "incompatible", uptimeSeconds: null, version: null }}
      />
    );
    expect(screen.getByText("Update required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("makes reconnecting transitions clear without exposing diagnostics", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{ state: "reconnecting", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "retrying automatically"
    );
    expect(document.body.textContent).not.toContain("socket");
  });

  it("labels the status section and announces title changes in one live region", () => {
    const { rerender } = render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{ state: "connecting", uptimeSeconds: null, version: null }}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Daemon status" })
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connecting…");

    rerender(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [],
        }}
      />
    );
    expect(screen.getByRole("status").textContent).toContain("Daemon running");
    expect(screen.getByText("under a minute")).toBeTruthy();
  });

  it("keeps version and uptime detail out of non-running states", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{ state: "unavailable", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.queryByText("Version")).toBeNull();
    expect(screen.queryByText("Uptime")).toBeNull();
  });

  it("keeps quitting the companion discoverable in every state", () => {
    const quit = vi.fn();
    const { rerender } = render(
      <StatusPopover
        quit={quit}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [],
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));
    expect(quit).toHaveBeenCalledOnce();

    rerender(
      <StatusPopover
        quit={quit}
        reconnect={() => undefined}
        status={{ state: "reconnecting", uptimeSeconds: null, version: null }}
      />
    );
    expect(screen.getByRole("button", { name: "Quit" })).toBeTruthy();
  });

  it("does not present a connected receiver with incomplete bindings as wholly ready", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [
            {
              detail: null,
              id: "slack:TFIRST",
              label: "TFIRST",
              readiness: "ready",
              teamId: "TFIRST",
              threads: [],
            },
            {
              detail: "setup-required",
              id: "slack:TSECOND",
              label: "TSECOND",
              readiness: "setup-incomplete",
              teamId: "TSECOND",
              threads: [],
            },
          ],
        }}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Workspace attention required"
    );
    expect(screen.getByText("1 connected")).toBeTruthy();
    expect(screen.getByText("0 pending")).toBeTruthy();
    expect(screen.getByText("1 unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Configure this workspace binding locally, then restart the daemon."
      )
    ).toBeTruthy();
  });

  it("keeps every workspace group visible and independently labelled", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [
            {
              detail: null,
              id: "slack:TREADY",
              label: "TREADY",
              readiness: "ready",
              teamId: "TREADY",
              threads: [],
            },
            {
              detail: null,
              id: "slack:TPENDING",
              label: "TPENDING",
              readiness: "pending",
              teamId: "TPENDING",
              threads: [],
            },
            {
              detail: "root-unavailable",
              id: "slack:TBROKEN",
              label: "TBROKEN",
              readiness: "unavailable",
              teamId: "TBROKEN",
              threads: [],
            },
            {
              detail: "configuration-invalid",
              id: "binding:3",
              label: "Workspace binding 4",
              readiness: "unknown",
              teamId: null,
              threads: [],
            },
          ],
        }}
      />
    );

    const groups = screen.getAllByRole("listitem");
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.textContent?.slice(0, 6))).toEqual([
      "TBROKE",
      "Worksp",
      "TPENDI",
      "TREADY",
    ]);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Starting")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("Status unknown")).toBeTruthy();
    expect(
      screen.getByText("Connected and listening for Slack work.")
    ).toBeTruthy();
    expect(screen.getByText("1 connected")).toBeTruthy();
    expect(screen.getByText("1 pending")).toBeTruthy();
    expect(screen.getByText("2 unavailable")).toBeTruthy();
  });

  it("groups actionable, ongoing, and recent threads beneath their owning workspace", () => {
    const now = Date.now();
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
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
                  activity: "needs-attention",
                  id: "workspace:TFIRST:C123:1000.000001",
                  label: "C123 · 1000.000001",
                  stateChangedAtUnixMs: now - 5 * 60_000,
                  workspaceId: "TFIRST",
                },
                {
                  activity: "in-progress",
                  id: "workspace:TFIRST:C123:1001.000001",
                  label: "C123 · 1001.000001",
                  stateChangedAtUnixMs: now - 30_000,
                  workspaceId: "TFIRST",
                },
                {
                  activity: "dormant",
                  id: "workspace:TFIRST:C123:1002.000001",
                  label: "C123 · 1002.000001",
                  stateChangedAtUnixMs: now - 3 * 3_600_000,
                  workspaceId: "TFIRST",
                },
              ],
            },
          ],
        }}
      />
    );

    const sections = screen.getAllByRole("heading", { level: 4 });
    expect(
      sections.map((section) => section.getAttribute("aria-label"))
    ).toEqual([
      "Needs attention, 1 work thread",
      "In progress, 1 work thread",
      "Recent, 1 work thread",
    ]);
    expect(screen.getByText("C123 · 1000.000001")).toBeTruthy();
    expect(screen.getByText("C123 · 1001.000001")).toBeTruthy();
    expect(screen.getByText("C123 · 1002.000001")).toBeTruthy();
    expect(document.body.textContent).not.toContain("prompt");
  });

  it("reports time in state relatively and reads it out with its activity", () => {
    const now = Date.now();
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
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
                  activity: "in-progress",
                  id: "workspace:TFIRST:C123:1001.000001",
                  label: "C123 · 1001.000001",
                  stateChangedAtUnixMs: now - 5 * 60_000,
                  workspaceId: "TFIRST",
                },
                {
                  activity: "dormant",
                  id: "workspace:TFIRST:C123:1002.000001",
                  label: "C123 · 1002.000001",
                  stateChangedAtUnixMs: now - 20_000,
                  workspaceId: "TFIRST",
                },
              ],
            },
          ],
        }}
      />
    );

    expect(screen.getByText("5m")).toBeTruthy();
    expect(screen.getByText("In progress for 5 minutes")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
    expect(screen.getByText("Recent for less than a minute")).toBeTruthy();
  });

  it("raises blocked work into the summary and orders its workspace first", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [
            {
              detail: null,
              id: "slack:TQUIET",
              label: "TQUIET",
              readiness: "ready",
              teamId: "TQUIET",
              threads: [],
            },
            {
              detail: null,
              id: "slack:TBLOCKED",
              label: "TBLOCKED",
              readiness: "ready",
              teamId: "TBLOCKED",
              threads: [
                {
                  activity: "needs-attention",
                  id: "workspace:TBLOCKED:C123:1000.000001",
                  label: "C123 · 1000.000001",
                  stateChangedAtUnixMs: Date.now() - 60_000,
                  workspaceId: "TBLOCKED",
                },
              ],
            },
          ],
        }}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Work needs attention"
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 work thread cannot progress without you"
    );
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["TBLOCKED", "TQUIET"]);
  });

  it("reports ongoing work without implying that anything is wrong", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
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
                  activity: "in-progress",
                  id: "workspace:TFIRST:C123:1001.000001",
                  label: "C123 · 1001.000001",
                  stateChangedAtUnixMs: Date.now(),
                  workspaceId: "TFIRST",
                },
              ],
            },
          ],
        }}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Work in progress"
    );
    expect(screen.getByRole("status").textContent).toContain(
      "still owes progress on 1 work thread"
    );
    expect(screen.queryByText("No active or recent work threads.")).toBeNull();
  });

  it("keeps the empty thread state out of workspaces that are not ready", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [
            {
              detail: "setup-required",
              id: "slack:TSETUP",
              label: "TSETUP",
              readiness: "setup-incomplete",
              teamId: "TSETUP",
              threads: [],
            },
          ],
        }}
      />
    );

    expect(screen.queryByText("No active or recent work threads.")).toBeNull();
    expect(
      screen.getByText(
        "Configure this workspace binding locally, then restart the daemon."
      )
    ).toBeTruthy();
  });

  it("opens recent work only when no live thread is competing for attention", () => {
    const recentThread = {
      activity: "dormant",
      id: "workspace:TFIRST:C123:1002.000001",
      label: "C123 · 1002.000001",
      stateChangedAtUnixMs: Date.now() - 3 * 3_600_000,
      workspaceId: "TFIRST",
    } as const;
    const quiet = render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [
            {
              detail: null,
              id: "slack:TFIRST",
              label: "TFIRST",
              readiness: "ready",
              teamId: "TFIRST",
              threads: [recentThread],
            },
          ],
        }}
      />
    );

    expect((screen.getByRole("group") as HTMLDetailsElement).open).toBe(true);
    quiet.unmount();

    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
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
                  activity: "in-progress",
                  id: "workspace:TFIRST:C123:1001.000001",
                  label: "C123 · 1001.000001",
                  stateChangedAtUnixMs: Date.now(),
                  workspaceId: "TFIRST",
                },
                recentThread,
              ],
            },
          ],
        }}
      />
    );

    expect((screen.getByRole("group") as HTMLDetailsElement).open).toBe(false);
  });

  it("explains the empty workspace surface without exposing configuration", () => {
    render(
      <StatusPopover
        quit={() => undefined}
        reconnect={() => undefined}
        status={{
          receiver: "connected",
          state: "running",
          uptimeSeconds: 45,
          version: "0.1.0",
          workspaces: [],
        }}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Slack workspaces" })
    ).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(emptyBindingsPattern)).toBeTruthy();
    expect(screen.queryByText("0 connected")).toBeNull();
    expect(document.body.textContent).not.toContain("laborer.json");
    expect(document.body.textContent).not.toContain("/");
  });
});
