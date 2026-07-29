import {
  CircleCheck,
  LoaderCircle,
  type LucideIcon,
  PlugZap,
  TriangleAlert,
} from "lucide-react";
import type { CompanionStatusView } from "../shared.ts";
import { Button } from "./components/ui/button.tsx";

type StatusTone = "danger" | "neutral" | "success" | "warning";

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "under a minute";
};

const statusPresentation: Record<
  CompanionStatusView["state"],
  {
    readonly action: string | null;
    readonly description: string;
    readonly guidance: string | null;
    readonly icon: LucideIcon;
    readonly indicator: string;
    readonly pending: boolean;
    readonly title: string;
    readonly tone: StatusTone;
  }
> = {
  connecting: {
    action: null,
    description: "Looking for the local Laborer daemon.",
    guidance: null,
    icon: LoaderCircle,
    indicator: "Connecting",
    pending: true,
    title: "Connecting…",
    tone: "neutral",
  },
  incompatible: {
    action: "Check again",
    description: "The companion and daemon use incompatible protocol versions.",
    guidance: "Update either Laborer component, then check the connection.",
    icon: TriangleAlert,
    indicator: "Update",
    pending: false,
    title: "Update required",
    tone: "danger",
  },
  reconnecting: {
    action: null,
    description: "Lost contact with the daemon and retrying automatically.",
    guidance: null,
    icon: LoaderCircle,
    indicator: "Reconnecting",
    pending: true,
    title: "Reconnecting…",
    tone: "warning",
  },
  "service-already-registered": {
    action: null,
    description:
      "The login service is already registered. Reconnecting to its daemon.",
    guidance: null,
    icon: LoaderCircle,
    indicator: "Registered",
    pending: true,
    title: "Adopting existing service…",
    tone: "neutral",
  },
  "service-denied": {
    action: "Try registration again",
    description: "macOS denied Laborer permission to run its login service.",
    guidance:
      "Allow Laborer in System Settings › General › Login Items, then retry.",
    icon: TriangleAlert,
    indicator: "Denied",
    pending: false,
    title: "Service permission denied",
    tone: "danger",
  },
  "service-registering": {
    action: null,
    description: "Registering the independent Laborer daemon with macOS.",
    guidance: null,
    icon: LoaderCircle,
    indicator: "Registering",
    pending: true,
    title: "Setting up daemon…",
    tone: "neutral",
  },
  "service-registered": {
    action: null,
    description: "The login service was registered. Waiting for its daemon.",
    guidance: null,
    icon: LoaderCircle,
    indicator: "Registered",
    pending: true,
    title: "Daemon registered…",
    tone: "neutral",
  },
  "service-requires-approval": {
    action: "Check approval",
    description: "macOS is waiting for approval before it can run Laborer.",
    guidance:
      "Allow Laborer in System Settings › General › Login Items, then check again.",
    icon: TriangleAlert,
    indicator: "Approval",
    pending: false,
    title: "Approval required",
    tone: "warning",
  },
  "service-unavailable": {
    action: "Try again",
    description: "Laborer cannot use macOS Service Management.",
    guidance: "Use the packaged macOS 13 or newer application, then retry.",
    icon: PlugZap,
    indicator: "Unavailable",
    pending: false,
    title: "Service unavailable",
    tone: "danger",
  },
  "service-version-mismatch": {
    action: "Check again",
    description: "The companion and bundled daemon executable do not match.",
    guidance:
      "Reinstall one complete Laborer application bundle before retrying.",
    icon: TriangleAlert,
    indicator: "Mismatch",
    pending: false,
    title: "Installation mismatch",
    tone: "danger",
  },
  running: {
    action: null,
    description: "Laborer is connected and ready for Slack work.",
    guidance: null,
    icon: CircleCheck,
    indicator: "Running",
    pending: false,
    title: "Daemon running",
    tone: "success",
  },
  unavailable: {
    action: "Try again",
    description: "Laborer cannot reach the local daemon.",
    guidance: "Start the daemon separately, then retry.",
    icon: PlugZap,
    indicator: "Offline",
    pending: false,
    title: "Daemon unavailable",
    tone: "warning",
  },
  "version-mismatch": {
    action: "Check again",
    description:
      "The registered daemon executable does not match this companion.",
    guidance:
      "Unregister the old service and reinstall one complete Laborer bundle.",
    icon: TriangleAlert,
    indicator: "Mismatch",
    pending: false,
    title: "Daemon version mismatch",
    tone: "danger",
  },
};

const badgeTone: Record<StatusTone, string> = {
  danger: "bg-danger/10 text-danger",
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
};

const dotTone: Record<StatusTone, string> = {
  danger: "bg-danger",
  neutral: "bg-muted-foreground/50",
  success: "bg-success",
  warning: "bg-warning",
};

type RunningStatus = Extract<
  CompanionStatusView,
  { readonly state: "running" }
>;

const runningPresentation = (
  status: RunningStatus
): (typeof statusPresentation)["running"] => {
  const pending = status.workspaces.filter(
    (workspace) => workspace.readiness === "pending"
  ).length;
  const unavailable =
    status.workspaces.length -
    pending -
    status.workspaces.filter((workspace) => workspace.readiness === "ready")
      .length;
  if (status.receiver === "connecting") {
    return {
      ...statusPresentation.running,
      description:
        "The daemon is available while the Slack receiver finishes connecting.",
      icon: LoaderCircle,
      indicator: "Connecting",
      pending: true,
      title: "Slack receiver connecting…",
      tone: "warning",
    };
  }
  if (unavailable > 0) {
    return {
      ...statusPresentation.running,
      description:
        "The Slack receiver is connected, but one or more workspace bindings need action.",
      icon: TriangleAlert,
      indicator: "Attention",
      title: "Workspace setup required",
      tone: "danger",
    };
  }
  if (pending > 0) {
    return {
      ...statusPresentation.running,
      description:
        "The Slack receiver is connected while workspace bindings finish starting.",
      icon: LoaderCircle,
      indicator: "Starting",
      pending: true,
      title: "Workspaces starting…",
      tone: "warning",
    };
  }
  return statusPresentation.running;
};

const bindingGuidance: Record<
  RunningStatus["workspaces"][number]["readiness"],
  string
> = {
  pending: "Starting now. No action is needed.",
  ready: "Ready for Slack work.",
  "setup-incomplete":
    "Configure this workspace binding locally, then restart the daemon.",
  unavailable: "Review this workspace's local setup, then restart the daemon.",
  unknown: "Restart the daemon. If this persists, review the workspace setup.",
};

const bindingDetailGuidance: Record<
  NonNullable<RunningStatus["workspaces"][number]["detail"]>,
  string
> = {
  "authentication-unavailable":
    "Verify this workspace's local Slack credentials, then restart the daemon.",
  "configuration-invalid":
    "Correct this workspace's local configuration, then restart the daemon.",
  "health-unavailable":
    "Restart the daemon. If this persists, review this workspace's local setup.",
  "identity-mismatch":
    "The authenticated Slack workspace does not match this binding. Correct it, then restart.",
  "ownership-unavailable":
    "The configured Laborer root is already in use. Stop its other owner, then restart.",
  "root-unavailable":
    "Make the configured Laborer root available, then restart the daemon.",
  "runtime-unavailable":
    "The local workspace runtime could not start. Review its setup, then restart.",
  "setup-required":
    "Configure this workspace binding locally, then restart the daemon.",
  "startup-stopped":
    "Workspace startup stopped unexpectedly. Restart the daemon to try again.",
};

const bindingTone: Record<
  RunningStatus["workspaces"][number]["readiness"],
  StatusTone
> = {
  pending: "warning",
  ready: "success",
  "setup-incomplete": "danger",
  unavailable: "danger",
  unknown: "warning",
};

const bindingTitle: Record<
  RunningStatus["workspaces"][number]["readiness"],
  string
> = {
  pending: "Starting",
  ready: "Ready",
  "setup-incomplete": "Setup required",
  unavailable: "Unavailable",
  unknown: "Status unknown",
};

export const StatusPopover = ({
  quit,
  reconnect,
  status,
}: {
  readonly quit: () => void;
  readonly reconnect: () => void;
  readonly status: CompanionStatusView;
}) => {
  const presentation =
    status.state === "running"
      ? runningPresentation(status)
      : statusPresentation[status.state];
  const Icon = presentation.icon;

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-border border-b px-5 py-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-base tracking-tight">Laborer</h1>
          <p className="text-muted-foreground text-xs">Local companion</p>
        </div>
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-2.5 pl-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
        >
          <span
            className={`size-1.5 rounded-full transition-colors ${dotTone[presentation.tone]} ${presentation.pending ? "animate-pulse motion-reduce:animate-none" : ""}`}
          />
          {presentation.indicator}
        </span>
      </header>

      <section
        aria-labelledby="daemon-status-heading"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5"
      >
        <h2 className="sr-only" id="daemon-status-heading">
          Daemon status
        </h2>

        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 shrink-0 rounded-full p-2 transition-colors ${badgeTone[presentation.tone]}`}
          >
            <Icon
              aria-hidden="true"
              className={
                presentation.pending
                  ? "size-5 animate-spin motion-reduce:animate-none"
                  : "size-5"
              }
            />
          </span>
          <output className="min-w-0 flex-1">
            <span className="block font-semibold text-sm leading-5">
              {presentation.title}
            </span>
            <span className="mt-1 block text-muted-foreground text-xs leading-5">
              {presentation.description}
            </span>
          </output>
        </div>

        {status.state === "running" ? (
          <dl className="mt-5 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border bg-surface p-3">
              <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
                Version
              </dt>
              <dd
                className="mt-1 select-text truncate font-mono text-sm"
                title={status.version}
              >
                {status.version}
              </dd>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
                Uptime
              </dt>
              <dd className="mt-1 select-text truncate font-medium text-sm">
                {formatUptime(status.uptimeSeconds)}
              </dd>
            </div>
          </dl>
        ) : null}

        {status.state === "running" ? (
          <>
            <section
              aria-labelledby="binding-summary-heading"
              className="mt-3 grid grid-cols-3 gap-2"
            >
              <h2 className="sr-only" id="binding-summary-heading">
                Workspace binding summary
              </h2>
              {[
                {
                  label: "connected",
                  value: status.workspaces.filter(
                    (workspace) => workspace.readiness === "ready"
                  ).length,
                },
                {
                  label: "pending",
                  value: status.workspaces.filter(
                    (workspace) => workspace.readiness === "pending"
                  ).length,
                },
                {
                  label: "unavailable",
                  value: status.workspaces.filter(
                    (workspace) =>
                      workspace.readiness !== "ready" &&
                      workspace.readiness !== "pending"
                  ).length,
                },
              ].map((count) => (
                <div
                  className="rounded-lg border border-border bg-surface px-2 py-2 text-center"
                  key={count.label}
                >
                  <span className="block font-semibold text-sm">
                    {count.value}
                  </span>
                  <span className="block text-[10px] text-muted-foreground uppercase tracking-wide">
                    {count.label}
                  </span>
                  <span className="sr-only">{`${count.value} ${count.label}`}</span>
                </div>
              ))}
            </section>

            <section
              aria-labelledby="workspace-bindings-heading"
              className="mt-5"
            >
              <h2
                className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide"
                id="workspace-bindings-heading"
              >
                Slack workspaces
              </h2>
              {status.workspaces.length === 0 ? (
                <p className="mt-2 rounded-xl border border-border bg-surface p-3 text-muted-foreground text-xs">
                  No workspace bindings are configured.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {status.workspaces.map((workspace) => (
                    <article
                      className="rounded-xl border border-border bg-surface p-3"
                      key={workspace.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold text-sm">
                            {workspace.label}
                          </h3>
                          <p className="mt-1 text-muted-foreground text-xs leading-5">
                            {workspace.detail === null
                              ? bindingGuidance[workspace.readiness]
                              : bindingDetailGuidance[workspace.detail]}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-1 font-medium text-[10px] ${badgeTone[bindingTone[workspace.readiness]]}`}
                        >
                          {bindingTitle[workspace.readiness]}
                        </span>
                      </div>
                      {workspace.readiness === "ready" ? (
                        <p className="mt-3 border-border border-t pt-3 text-muted-foreground text-xs">
                          No visible work in this workspace.
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        {presentation.action !== null && presentation.guidance !== null ? (
          <div className="mt-5 rounded-xl border border-border bg-surface p-4">
            <p className="text-muted-foreground text-xs leading-5">
              {presentation.guidance}
            </p>
            <Button
              className="mt-3 w-full"
              onClick={reconnect}
              variant="primary"
            >
              {presentation.action}
            </Button>
          </div>
        ) : null}
      </section>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-border border-t px-5 py-3">
        <p className="min-w-0 text-[11px] text-muted-foreground leading-4">
          Quitting the companion never stops daemon work.
        </p>
        <Button className="shrink-0" onClick={quit} variant="outline">
          Quit
        </Button>
      </footer>
    </main>
  );
};
