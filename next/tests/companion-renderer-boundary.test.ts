import { describe, expect, it } from "vitest";
import { isOperatorStatusView } from "../src/companion/shared.ts";

describe("companion renderer boundary", () => {
  it("accepts only the narrow validated status view model", () => {
    expect(
      isOperatorStatusView({
        state: "running",
        uptimeSeconds: 42,
        version: "0.1.0",
      })
    ).toBe(true);
    expect(
      isOperatorStatusView({
        socketPath: "/private/operator.sock",
        state: "running",
        token: "secret",
        uptimeSeconds: 42,
        version: "0.1.0",
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
        state: "running",
        uptimeSeconds: -1,
        version: "0.1.0",
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
