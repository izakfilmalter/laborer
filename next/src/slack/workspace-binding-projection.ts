import {
  MAX_OPERATOR_WORKSPACE_BINDINGS,
  type OperatorWorkspaceBinding,
} from "../operator-status/protocol.ts";
import type { SlackDaemonConfig, SlackInstallationConfig } from "./config.ts";
import type { SlackWorkspacePreflightReport } from "./workspace-startup.ts";

export interface WorkspaceBindingProjectionSnapshot {
  readonly receiver: "connected" | "connecting";
  readonly workspaces: readonly OperatorWorkspaceBinding[];
}

const TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;

const safeTeamId = (teamId: string | undefined): string | null =>
  teamId !== undefined && teamId.length <= 58 && TEAM_ID_PATTERN.test(teamId)
    ? teamId
    : null;

const initialBinding = (
  installation: SlackInstallationConfig
): OperatorWorkspaceBinding => {
  const teamId = safeTeamId(installation.expectedTeamId);
  if (installation.validation._tag === "Invalid") {
    return {
      detail: "configuration-invalid",
      id: `binding:${installation.bindingIndex}`,
      label: `Workspace binding ${installation.bindingIndex + 1}`,
      readiness: "unknown",
      teamId: null,
    };
  }
  return {
    detail: null,
    id:
      teamId === null
        ? `binding:${installation.bindingIndex}`
        : `slack:${teamId}`,
    label:
      teamId === null
        ? `Workspace binding ${installation.bindingIndex + 1}`
        : teamId,
    readiness: "pending",
    teamId,
  };
};

const detailForReport = (
  report: SlackWorkspacePreflightReport
): OperatorWorkspaceBinding["detail"] => {
  switch (report.reasonCode) {
    case "workspace-authentication-unavailable":
      return "authentication-unavailable";
    case "laborer-config-incompatible":
      return "configuration-invalid";
    case "workspace-identity-mismatch":
      return "identity-mismatch";
    case "workspace-root-lock-unavailable":
      return "ownership-unavailable";
    case "workspace-root-unavailable":
      return "root-unavailable";
    case "root-runtime-unavailable":
    case "acp-runner-quarantined":
      return "runtime-unavailable";
    case "workspace-root-missing":
      return "setup-required";
    case "workspace-initialization-stopped":
      return "startup-stopped";
    default:
      return report.status === "ready" ? null : "health-unavailable";
  }
};

const readinessForReport = (
  report: SlackWorkspacePreflightReport
): OperatorWorkspaceBinding["readiness"] => {
  if (report.status === "ready") {
    return "ready";
  }
  if (report.status === "setup-incomplete") {
    return "setup-incomplete";
  }
  return "unavailable";
};

export const makeWorkspaceBindingProjection = (config: SlackDaemonConfig) => {
  if (config.installations.length > MAX_OPERATOR_WORKSPACE_BINDINGS) {
    throw new Error(
      "too many Slack workspace bindings for operator projection"
    );
  }
  let receiver: WorkspaceBindingProjectionSnapshot["receiver"] = "connecting";
  const workspaces = config.installations.map(initialBinding);

  return {
    markReceiverConnected: (): void => {
      receiver = "connected";
    },
    observe: (report: SlackWorkspacePreflightReport): void => {
      const installation = config.installations[report.bindingIndex];
      const current = workspaces[report.bindingIndex];
      if (installation === undefined || current === undefined) {
        return;
      }
      // Malformed registry entries have no trustworthy workspace identity. Keep
      // them explicitly unknown instead of promoting a startup fallback into a
      // second source of truth.
      if (installation.validation._tag === "Invalid") {
        return;
      }
      const teamId =
        current.teamId ??
        safeTeamId(report.teamId ?? installation.expectedTeamId);
      workspaces[report.bindingIndex] = {
        detail: detailForReport(report),
        id: current.id,
        label: teamId === null ? current.label : teamId,
        readiness: readinessForReport(report),
        teamId,
      };
    },
    snapshot: (): WorkspaceBindingProjectionSnapshot => ({
      receiver,
      workspaces: workspaces.map((workspace) => ({ ...workspace })),
    }),
  };
};
