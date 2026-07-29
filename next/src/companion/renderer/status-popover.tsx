import {
  CircleCheck,
  CircleDot,
  Clock3,
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

type WorkspaceBinding = RunningStatus["workspaces"][number];
type WorkThread = WorkspaceBinding["threads"][number];

interface BindingCounts {
  readonly pending: number;
  readonly ready: number;
  readonly unavailable: number;
}

const bindingCounts = (
  workspaces: RunningStatus["workspaces"]
): BindingCounts => ({
  pending: workspaces.filter((workspace) => workspace.readiness === "pending")
    .length,
  ready: workspaces.filter((workspace) => workspace.readiness === "ready")
    .length,
  unavailable: workspaces.filter(
    (workspace) =>
      workspace.readiness !== "ready" && workspace.readiness !== "pending"
  ).length,
});

const runningPresentation = (
  status: RunningStatus
): (typeof statusPresentation)["running"] => {
  const { pending, unavailable } = bindingCounts(status.workspaces);
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
      title: "Workspace attention required",
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
  Exclude<WorkspaceBinding["readiness"], "ready">,
  string
> = {
  pending: "Starting now. No action is needed.",
  "setup-incomplete":
    "Configure this workspace binding locally, then restart the daemon.",
  unavailable: "Review this workspace's local setup, then restart the daemon.",
  unknown: "Restart the daemon. If this persists, review the workspace setup.",
};

const bindingDetailGuidance: Record<
  NonNullable<WorkspaceBinding["detail"]>,
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

const bindingTone: Record<WorkspaceBinding["readiness"], StatusTone> = {
  pending: "warning",
  ready: "success",
  "setup-incomplete": "danger",
  unavailable: "danger",
  unknown: "warning",
};

const bindingTitle: Record<WorkspaceBinding["readiness"], string> = {
  pending: "Starting",
  ready: "Ready",
  "setup-incomplete": "Setup required",
  unavailable: "Unavailable",
  unknown: "Status unknown",
};

const bindingBody = (workspace: WorkspaceBinding): string => {
  if (workspace.readiness === "ready") {
    return "Connected and listening for Slack work.";
  }
  return workspace.detail === null
    ? bindingGuidance[workspace.readiness]
    : bindingDetailGuidance[workspace.detail];
};

const bindingRank: Record<WorkspaceBinding["readiness"], number> = {
  pending: 1,
  ready: 2,
  "setup-incomplete": 0,
  unavailable: 0,
  unknown: 0,
};

// Workspaces that need operator action come first so the actionable bindings
// stay visible without scrolling the popover.
const orderedBindings = (
  workspaces: RunningStatus["workspaces"]
): readonly WorkspaceBinding[] =>
  workspaces
    .map((workspace, index) => ({ index, workspace }))
    .sort(
      (left, right) =>
        bindingRank[left.workspace.readiness] -
          bindingRank[right.workspace.readiness] || left.index - right.index
    )
    .map((entry) => entry.workspace);

const activityTitle: Record<WorkThread["activity"], string> = {
  "in-progress": "In progress",
  "needs-attention": "Needs attention",
  dormant: "Recent",
};

const activityTone: Record<WorkThread["activity"], StatusTone> = {
  "in-progress": "warning",
  "needs-attention": "danger",
  dormant: "neutral",
};

const WorkThreadRow = ({ thread }: { readonly thread: WorkThread }) => {
  const tone = activityTone[thread.activity];
  const changed = new Date(thread.stateChangedAtUnixMs);
  return (
    <li className="flex items-start gap-2.5 border-border border-t px-3 py-2.5 first:border-t-0">
      {thread.activity === "dormant" ? (
        <Clock3
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <CircleDot
          aria-hidden="true"
          className={`mt-0.5 size-3.5 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-xs leading-4"
          title={thread.label}
        >
          {thread.label}
        </p>
        <time
          className="mt-0.5 block text-[11px] text-muted-foreground leading-4"
          dateTime={changed.toISOString()}
          title={changed.toLocaleString()}
        >
          Status changed{" "}
          {changed.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </div>
      <span
        className={`mt-0.5 size-1.5 shrink-0 rounded-full ${dotTone[tone]} ${thread.activity === "in-progress" ? "animate-pulse motion-reduce:animate-none" : ""}`}
      />
    </li>
  );
};

const WorkThreadSections = ({
  threads,
}: {
  readonly threads: WorkspaceBinding["threads"];
}) => {
  const sections = (["needs-attention", "in-progress", "dormant"] as const).map(
    (activity) => ({
      activity,
      threads: threads.filter((thread) => thread.activity === activity),
    })
  );
  if (threads.length === 0) {
    return (
      <p className="border-border border-t px-3 py-3 text-muted-foreground text-xs leading-5">
        No active or recent work threads.
      </p>
    );
  }
  return (
    <div className="border-border border-t">
      {sections.map(({ activity, threads: sectionThreads }) =>
        sectionThreads.length === 0 ? null : (
          <section key={activity}>
            <h4 className="bg-muted/40 px-3 py-1.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
              {activityTitle[activity]}{" "}
              <span className="ml-1.5 tabular-nums">
                {sectionThreads.length}
              </span>
            </h4>
            <ul>
              {sectionThreads.map((thread) => (
                <WorkThreadRow key={thread.id} thread={thread} />
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  );
};

const WorkspaceBindingCard = ({
  workspace,
}: {
  readonly workspace: WorkspaceBinding;
}) => {
  const tone = bindingTone[workspace.readiness];
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3
            className={`min-w-0 flex-1 truncate font-semibold text-sm leading-5 ${workspace.teamId === null ? "" : "font-mono"}`}
            title={workspace.label}
          >
            {workspace.label}
          </h3>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-[11px] leading-5 ${badgeTone[tone]}`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${dotTone[tone]} ${workspace.readiness === "pending" ? "animate-pulse motion-reduce:animate-none" : ""}`}
            />
            {bindingTitle[workspace.readiness]}
          </span>
        </div>
        <p className="mt-1.5 text-muted-foreground text-xs leading-5">
          {bindingBody(workspace)}
        </p>
      </div>
      <WorkThreadSections threads={workspace.threads} />
    </article>
  );
};

const BindingCountChip = ({
  label,
  pending,
  tone,
  value,
}: {
  readonly label: string;
  readonly pending: boolean;
  readonly tone: StatusTone;
  readonly value: number;
}) => (
  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-2.5 pl-2 text-[11px] leading-4">
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${value === 0 ? "bg-muted-foreground/40" : dotTone[tone]} ${pending && value > 0 ? "animate-pulse motion-reduce:animate-none" : ""}`}
    />
    <span
      aria-hidden="true"
      className={`font-semibold tabular-nums ${value === 0 ? "text-muted-foreground" : "text-foreground"}`}
    >
      {value}
    </span>
    <span aria-hidden="true" className="text-muted-foreground">
      {label}
    </span>
    <span className="sr-only">{`${value} ${label}`}</span>
  </span>
);

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
  const counts = bindingCounts(
    status.state === "running" ? status.workspaces : []
  );
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
          <>
            <dl className="mt-4 flex overflow-hidden rounded-xl border border-border bg-surface">
              <div className="min-w-0 flex-1 px-3 py-2">
                <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Version
                </dt>
                <dd
                  className="mt-0.5 select-text truncate font-mono text-sm"
                  title={status.version}
                >
                  {status.version}
                </dd>
              </div>
              <div className="min-w-0 flex-1 border-border border-l px-3 py-2">
                <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Uptime
                </dt>
                <dd className="mt-0.5 select-text truncate font-medium text-sm">
                  {formatUptime(status.uptimeSeconds)}
                </dd>
              </div>
            </dl>

            {status.workspaces.length > 0 ? (
              <section
                aria-labelledby="binding-summary-heading"
                className="mt-2 flex flex-wrap items-center gap-1.5"
              >
                <h2 className="sr-only" id="binding-summary-heading">
                  Workspace binding summary
                </h2>
                <BindingCountChip
                  label="connected"
                  pending={false}
                  tone="success"
                  value={counts.ready}
                />
                <BindingCountChip
                  label="pending"
                  pending={true}
                  tone="warning"
                  value={counts.pending}
                />
                <BindingCountChip
                  label="unavailable"
                  pending={false}
                  tone="danger"
                  value={counts.unavailable}
                />
              </section>
            ) : null}

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
                <p className="mt-2 rounded-xl border border-border border-dashed bg-surface p-3 text-muted-foreground text-xs leading-5">
                  No workspace bindings are configured. Bind a Slack workspace
                  to this daemon to see its readiness here.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {orderedBindings(status.workspaces).map((workspace) => (
                    <li key={workspace.id}>
                      <WorkspaceBindingCard workspace={workspace} />
                    </li>
                  ))}
                </ul>
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
