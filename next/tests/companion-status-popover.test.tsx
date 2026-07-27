// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPopover } from "../src/companion/renderer/status-popover.tsx";

afterEach(cleanup);

describe("companion status popover", () => {
  it("presents live daemon identity and uptime with an accessible hierarchy", () => {
    render(
      <StatusPopover
        reconnect={() => undefined}
        status={{ state: "running", uptimeSeconds: 3723, version: "0.1.0" }}
      />
    );

    expect(screen.getByRole("heading", { name: "Laborer" })).toBeTruthy();
    expect(screen.getByText("Daemon running")).toBeTruthy();
    expect(screen.getByText("1h 2m")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "ready for Slack work"
    );
  });

  it("offers an explicit retry in unavailable and incompatible states", () => {
    const reconnect = vi.fn();
    const { rerender } = render(
      <StatusPopover
        reconnect={reconnect}
        status={{ state: "unavailable", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.getByText("Daemon unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reconnect).toHaveBeenCalledOnce();

    rerender(
      <StatusPopover
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
        reconnect={() => undefined}
        status={{ state: "reconnecting", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "retrying automatically"
    );
    expect(document.body.textContent).not.toContain("socket");
  });

  it("labels the status section and announces title changes in one live region", () => {
    const { rerender } = render(
      <StatusPopover
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
        reconnect={() => undefined}
        status={{ state: "running", uptimeSeconds: 45, version: "0.1.0" }}
      />
    );
    expect(screen.getByRole("status").textContent).toContain("Daemon running");
    expect(screen.getByText("under a minute")).toBeTruthy();
  });

  it("keeps version and uptime detail out of non-running states", () => {
    render(
      <StatusPopover
        reconnect={() => undefined}
        status={{ state: "unavailable", uptimeSeconds: null, version: null }}
      />
    );

    expect(screen.queryByText("Version")).toBeNull();
    expect(screen.queryByText("Uptime")).toBeNull();
  });
});
