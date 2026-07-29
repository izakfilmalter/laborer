import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import type { SlackDaemonConfig } from "../src/slack/config.ts";
import { makeWorkspaceBindingProjection } from "../src/slack/workspace-binding-projection.ts";

const config = (entries: readonly ("first" | "second" | "unknown")[]) =>
  ({
    appToken: Redacted.make("redacted"),
    installations: entries.map((entry, bindingIndex) =>
      entry === "unknown"
        ? {
            bindingIndex,
            botToken: Redacted.make(""),
            botTokenEnvironment: "",
            namespaceWorkspace: true,
            tokenIsValid: false,
            validation: { _tag: "Invalid", reason: "invalid-shape" },
          }
        : {
            bindingIndex,
            botToken: Redacted.make("redacted"),
            botTokenEnvironment: `SLACK_BOT_TOKEN_${entry.toUpperCase()}`,
            expectedTeamId: entry === "first" ? "TFIRST" : "TSECOND",
            namespaceWorkspace: true,
            root: "/private/root",
            tokenIsValid: true,
            validation: { _tag: "Valid" },
          }
    ),
    startupMode: "multi-workspace",
  }) satisfies SlackDaemonConfig;

describe("workspace-binding operator projection", () => {
  it("reports all configured workspaces ready without coupling shared roots", () => {
    const projection = makeWorkspaceBindingProjection(
      config(["first", "second"])
    );
    for (const [bindingIndex, teamId] of ["TFIRST", "TSECOND"].entries()) {
      projection.observe({
        bindingIndex,
        reasonCode: "acp-workspace-ready",
        status: "ready",
        teamId,
      });
    }

    expect(
      projection.snapshot().workspaces.map(({ readiness }) => readiness)
    ).toEqual(["ready", "ready"]);
  });

  it("projects configured bindings independently in stable registry order", () => {
    const projection = makeWorkspaceBindingProjection(
      config(["first", "second"])
    );

    projection.observe({
      bindingIndex: 1,
      reasonCode: "workspace-root-missing",
      status: "setup-incomplete",
      teamId: "TSECOND",
    });
    projection.observe({
      bindingIndex: 0,
      reasonCode: "acp-workspace-ready",
      status: "ready",
      teamId: "TFIRST",
    });
    projection.markReceiverConnected();

    expect(projection.snapshot()).toEqual({
      receiver: "connected",
      workspaces: [
        {
          detail: null,
          id: "slack:TFIRST",
          label: "TFIRST",
          readiness: "ready",
          teamId: "TFIRST",
        },
        {
          detail: "setup-required",
          id: "slack:TSECOND",
          label: "TSECOND",
          readiness: "setup-incomplete",
          teamId: "TSECOND",
        },
      ],
    });
  });

  it("keeps pending, unavailable, shared-root, and unknown bindings isolated", () => {
    const projection = makeWorkspaceBindingProjection(
      config(["first", "second", "unknown"])
    );

    projection.observe({
      bindingIndex: 1,
      reasonCode: "root-runtime-unavailable",
      status: "quarantined",
      teamId: "TSECOND",
    });

    expect(projection.snapshot().workspaces).toEqual([
      expect.objectContaining({ id: "slack:TFIRST", readiness: "pending" }),
      expect.objectContaining({
        detail: "runtime-unavailable",
        id: "slack:TSECOND",
        readiness: "unavailable",
      }),
      expect.objectContaining({
        detail: "configuration-invalid",
        id: "binding:2",
        readiness: "unknown",
        teamId: null,
      }),
    ]);
  });

  it("preserves healthy state beside pending or unavailable bindings", () => {
    const pending = makeWorkspaceBindingProjection(config(["first", "second"]));
    pending.observe({
      bindingIndex: 0,
      reasonCode: "acp-workspace-ready",
      status: "ready",
      teamId: "TFIRST",
    });
    expect(
      pending.snapshot().workspaces.map(({ readiness }) => readiness)
    ).toEqual(["ready", "pending"]);

    const unavailable = makeWorkspaceBindingProjection(
      config(["first", "second"])
    );
    unavailable.observe({
      bindingIndex: 0,
      reasonCode: "acp-workspace-ready",
      status: "ready",
      teamId: "TFIRST",
    });
    unavailable.observe({
      bindingIndex: 1,
      reasonCode: "root-runtime-unavailable",
      status: "quarantined",
      teamId: "TSECOND",
    });
    expect(
      unavailable.snapshot().workspaces.map(({ readiness }) => readiness)
    ).toEqual(["ready", "unavailable"]);
  });

  it("ignores reports for unknown registry indexes", () => {
    const projection = makeWorkspaceBindingProjection(config(["first"]));
    const before = projection.snapshot();

    projection.observe({
      bindingIndex: 99,
      reasonCode: "acp-workspace-ready",
      status: "ready",
      teamId: "TUNKNOWN",
    });

    expect(projection.snapshot()).toEqual(before);
  });

  it("keeps malformed authenticated identities out of the operator boundary", () => {
    const legacyConfig = config(["first"]);
    const sourceInstallation = legacyConfig.installations[0];
    if (sourceInstallation === undefined) {
      throw new Error("missing fixture installation");
    }
    const projection = makeWorkspaceBindingProjection({
      ...legacyConfig,
      installations: [
        {
          bindingIndex: sourceInstallation.bindingIndex,
          botToken: sourceInstallation.botToken,
          botTokenEnvironment: sourceInstallation.botTokenEnvironment,
          namespaceWorkspace: false,
          ...(sourceInstallation.root === undefined
            ? {}
            : { root: sourceInstallation.root }),
          tokenIsValid: sourceInstallation.tokenIsValid,
          validation: sourceInstallation.validation,
        },
      ],
      startupMode: "legacy",
    });

    projection.observe({
      bindingIndex: 0,
      reasonCode: "acp-workspace-ready",
      status: "ready",
      teamId: "../../private-root",
    });

    expect(projection.snapshot().workspaces).toEqual([
      {
        detail: null,
        id: "binding:0",
        label: "Workspace binding 1",
        readiness: "ready",
        teamId: null,
      },
    ]);
  });
});
