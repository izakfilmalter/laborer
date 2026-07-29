import {
  ChevronRight,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  type LucideIcon,
  PlugZap,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
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
type PendingExecution = WorkThread["executions"][number];

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

const countThreads = (
  workspaces: RunningStatus["workspaces"],
  activity: WorkThread["activity"]
): number =>
  workspaces.reduce(
    (count, workspace) =>
      count +
      workspace.threads.filter((thread) => thread.activity === activity).length,
    0
  );

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const runningPresentation = (
  status: RunningStatus
): (typeof statusPresentation)["running"] => {
  const { pending, unavailable } = bindingCounts(status.workspaces);
  const blockedThreads = countThreads(status.workspaces, "needs-attention");
  const activeThreads = countThreads(status.workspaces, "in-progress");
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
  if (blockedThreads > 0) {
    return {
      ...statusPresentation.running,
      description: `Laborer is running while ${plural(blockedThreads, "work thread")} cannot progress without you.`,
      icon: TriangleAlert,
      indicator: "Attention",
      title: "Work needs attention",
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
  if (activeThreads > 0) {
    return {
      ...statusPresentation.running,
      description: `Laborer still owes progress on ${plural(activeThreads, "work thread")}.`,
      icon: LoaderCircle,
      indicator: "Working",
      pending: true,
      title: "Work in progress",
      tone: "success",
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

// Actionable work outranks ordinary activity within an equally healthy binding.
const workspaceActivityRank = (workspace: WorkspaceBinding): number => {
  if (
    workspace.threads.some((thread) => thread.activity === "needs-attention")
  ) {
    return 0;
  }
  return workspace.threads.some((thread) => thread.activity === "in-progress")
    ? 1
    : 2;
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
          bindingRank[right.workspace.readiness] ||
        workspaceActivityRank(left.workspace) -
          workspaceActivityRank(right.workspace) ||
        left.index - right.index
    )
    .map((entry) => entry.workspace);

// Row composition, ordering, title treatment, density, and the recent-section
// disclosure below are tracer hypotheses meant to be revised after operator use.
const activityPresentation: Record<
  WorkThread["activity"],
  {
    readonly icon: LucideIcon;
    readonly iconClassName: string;
    readonly labelClassName: string;
    readonly rowClassName: string;
    readonly title: string;
    readonly tone: StatusTone;
  }
> = {
  // Ongoing work is healthy, so it reads in the same tone as the summary above
  // rather than borrowing the warning tone that marks transitional bindings.
  "in-progress": {
    icon: CircleDot,
    iconClassName: "animate-pulse text-success motion-reduce:animate-none",
    labelClassName: "text-foreground",
    rowClassName: "",
    title: "In progress",
    tone: "success",
  },
  "needs-attention": {
    icon: TriangleAlert,
    iconClassName: "text-danger",
    labelClassName: "text-foreground",
    rowClassName: "bg-danger/5",
    title: "Needs attention",
    tone: "danger",
  },
  dormant: {
    icon: CircleCheck,
    iconClassName: "text-muted-foreground",
    labelClassName: "text-muted-foreground",
    rowClassName: "",
    title: "Recent",
    tone: "neutral",
  },
};

const MAX_DISPLAY_DAYS = 99;
const STATE_AGE_TICK_MS = 30_000;

// Time in state is what an operator scans, so it stays relative and compact
// while the accessible name and tooltip keep the exact moment available.
const stateAge = (
  elapsedMs: number
): { readonly compact: string; readonly spoken: string } => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) {
    return { compact: "now", spoken: "less than a minute" };
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return { compact: `${minutes}m`, spoken: plural(minutes, "minute") };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { compact: `${hours}h`, spoken: plural(hours, "hour") };
  }
  const days = Math.floor(hours / 24);
  return days > MAX_DISPLAY_DAYS
    ? {
        compact: `${MAX_DISPLAY_DAYS}d+`,
        spoken: `more than ${MAX_DISPLAY_DAYS} days`,
      }
    : { compact: `${days}d`, spoken: plural(days, "day") };
};

const useNow = (intervalMs: number | null): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

const executionLifecycleLabel: Record<PendingExecution["lifecycle"], string> = {
  allocated: "Allocated",
  cancelling: "Cancelling",
  "implementation-ready": "Implementation ready",
  "recovery-blocked": "Recovery blocked",
  running: "Running",
  starting: "Starting",
};

const PendingExecutionRow = ({
  execution,
  nowUnixMs,
}: {
  readonly execution: PendingExecution;
  readonly nowUnixMs: number;
}) => {
  const started =
    execution.startedAtUnixMs === null
      ? null
      : new Date(execution.startedAtUnixMs);
  const age =
    execution.startedAtUnixMs === null
      ? null
      : stateAge(nowUnixMs - execution.startedAtUnixMs);
  const blocked = execution.lifecycle === "recovery-blocked";
  return (
    <li className="flex items-center gap-2 border-border/70 border-t px-3 py-1.5 pl-9">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${blocked ? "bg-danger" : "bg-success"}`}
      />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate font-medium text-xs leading-4"
          title={execution.actionName}
        >
          {execution.actionName}
        </span>
        <span
          className={`block text-[11px] leading-4 ${blocked ? "text-danger" : "text-muted-foreground"}`}
        >
          {executionLifecycleLabel[execution.lifecycle]}
        </span>
      </span>
      {started === null || age === null ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          Start unknown
        </span>
      ) : (
        <time
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          dateTime={started.toISOString()}
          title={started.toLocaleString()}
        >
          <span aria-hidden="true">{age.compact}</span>
          <span className="sr-only">{`Running for ${age.spoken}`}</span>
        </time>
      )}
    </li>
  );
};

const WorkThreadRow = ({
  nowUnixMs,
  thread,
}: {
  readonly nowUnixMs: number;
  readonly thread: WorkThread;
}) => {
  const presentation = activityPresentation[thread.activity];
  const Icon = presentation.icon;
  const changed = new Date(thread.stateChangedAtUnixMs);
  const age = stateAge(nowUnixMs - thread.stateChangedAtUnixMs);
  return (
    <li
      className={`border-border border-t first:border-t-0 ${presentation.rowClassName}`}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon
          aria-hidden="true"
          className={`size-3.5 shrink-0 ${presentation.iconClassName}`}
        />
        <span
          className={`min-w-0 flex-1 truncate font-medium font-mono text-xs leading-5 ${presentation.labelClassName}`}
          title={thread.label}
        >
          {thread.label}
        </span>
        <time
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums leading-4"
          dateTime={changed.toISOString()}
          title={changed.toLocaleString()}
        >
          <span aria-hidden="true">{age.compact}</span>
          <span className="sr-only">{`${presentation.title} for ${age.spoken}`}</span>
        </time>
      </div>
      {thread.executions.length === 0 ? null : (
        <ul aria-label={`Pending Executions for ${thread.label}`}>
          {thread.executions.map((execution) => (
            <PendingExecutionRow
              execution={execution}
              key={execution.id}
              nowUnixMs={nowUnixMs}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

const sectionHeadingClassName =
  "flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-wide";

const WorkThreadSection = ({
  activity,
  headingId,
  nowUnixMs,
  open,
  threads,
}: {
  readonly activity: WorkThread["activity"];
  readonly headingId: string;
  readonly nowUnixMs: number;
  readonly open: boolean;
  readonly threads: readonly WorkThread[];
}) => {
  // The disclosure stays operator-controlled once opened: status pushes and the
  // relative-time tick re-render this card, and neither should collapse it.
  const [expanded, setExpanded] = useState(open);
  const presentation = activityPresentation[activity];
  const rows = (
    <ul aria-labelledby={headingId}>
      {threads.map((thread) => (
        <WorkThreadRow key={thread.id} nowUnixMs={nowUnixMs} thread={thread} />
      ))}
    </ul>
  );
  const count = (
    <span aria-hidden="true" className="font-normal tabular-nums">
      {threads.length}
    </span>
  );
  const headingLabel = `${presentation.title}, ${plural(threads.length, "work thread")}`;
  // Settled work is the least actionable, so it stays one disclosure away
  // while in-progress and needs-attention rows keep the top of the card.
  if (activity === "dormant") {
    return (
      <details
        className="group"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        open={expanded}
      >
        <summary className="list-none rounded-none bg-muted/40 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
          <h4
            aria-label={headingLabel}
            className={`${sectionHeadingClassName} cursor-pointer select-none px-3 py-1.5 text-muted-foreground`}
            id={headingId}
          >
            <ChevronRight
              aria-hidden="true"
              className="-ml-1 size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            />
            {presentation.title}
            {count}
          </h4>
        </summary>
        {rows}
      </details>
    );
  }
  return (
    <section aria-labelledby={headingId}>
      <h4
        aria-label={headingLabel}
        className={`${sectionHeadingClassName} px-3 py-1.5 ${
          presentation.tone === "danger"
            ? "bg-danger/10 text-danger"
            : "bg-muted/40 text-muted-foreground"
        }`}
        id={headingId}
      >
        {presentation.title}
        {count}
      </h4>
      {rows}
    </section>
  );
};

const WorkThreadSections = ({
  nowUnixMs,
  workspace,
}: {
  readonly nowUnixMs: number;
  readonly workspace: WorkspaceBinding;
}) => {
  const sections = (["needs-attention", "in-progress", "dormant"] as const).map(
    (activity) => ({
      activity,
      threads: workspace.threads.filter(
        (thread) => thread.activity === activity
      ),
    })
  );
  if (workspace.threads.length === 0) {
    // A binding that is not ready explains itself above; an empty thread list
    // there would read as a second, misleading state.
    return workspace.readiness === "ready" ? (
      <p className="border-border border-t px-3 py-3 text-muted-foreground text-xs leading-5">
        No active or recent work threads.
      </p>
    ) : null;
  }
  // With nothing live to read, recent work is the only story the card can tell,
  // so it opens rather than leaving the operator facing a collapsed strip.
  const hasLiveWork = sections.some(
    ({ activity, threads }) => activity !== "dormant" && threads.length > 0
  );
  return (
    <div className="border-border border-t">
      {sections.map(({ activity, threads }) =>
        threads.length === 0 ? null : (
          <WorkThreadSection
            activity={activity}
            headingId={`${workspace.id}-${activity}`}
            key={activity}
            nowUnixMs={nowUnixMs}
            open={!hasLiveWork}
            threads={threads}
          />
        )
      )}
    </div>
  );
};

const WorkspaceBindingCard = ({
  nowUnixMs,
  workspace,
}: {
  readonly nowUnixMs: number;
  readonly workspace: WorkspaceBinding;
}) => {
  const tone = bindingTone[workspace.readiness];
  // A card the operator has to act on carries its urgency at the card edge so
  // it is findable in a scroll of otherwise identical cards.
  const needsAction =
    tone === "danger" ||
    workspace.threads.some((thread) => thread.activity === "needs-attention");
  return (
    <article
      className={`overflow-hidden rounded-xl border bg-surface ${needsAction ? "border-danger/40" : "border-border"}`}
    >
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
      <WorkThreadSections nowUnixMs={nowUnixMs} workspace={workspace} />
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
  const workspaces = status.state === "running" ? status.workspaces : [];
  const counts = bindingCounts(workspaces);
  const hasThreads = workspaces.some(
    (workspace) => workspace.threads.length > 0
  );
  const nowUnixMs = useNow(hasThreads ? STATE_AGE_TICK_MS : null);
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
                      <WorkspaceBindingCard
                        nowUnixMs={nowUnixMs}
                        workspace={workspace}
                      />
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
