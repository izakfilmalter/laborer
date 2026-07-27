import {
  CircleCheck,
  LoaderCircle,
  type LucideIcon,
  PlugZap,
  TriangleAlert,
} from "lucide-react";
import type { OperatorStatusView } from "../../operator-status/client.ts";
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
  OperatorStatusView["state"],
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

export const StatusPopover = ({
  reconnect,
  status,
}: {
  readonly reconnect: () => void;
  readonly status: OperatorStatusView;
}) => {
  const presentation = statusPresentation[status.state];
  const Icon = presentation.icon;

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-border border-b px-5 py-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-base tracking-tight">Laborer</h1>
          <p className="text-muted-foreground text-xs">Local companion</p>
        </div>
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-2.5 pl-2 font-medium text-[10px] text-muted-foreground uppercase tracking-wider"
        >
          <span
            className={`size-1.5 rounded-full transition-colors ${dotTone[presentation.tone]} ${presentation.pending ? "animate-pulse motion-reduce:animate-none" : ""}`}
          />
          {presentation.indicator}
        </span>
      </header>

      <section
        aria-labelledby="daemon-status-heading"
        className="flex flex-1 flex-col p-5"
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
              <dt className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Version
              </dt>
              <dd className="mt-1 truncate font-mono text-sm">
                {status.version}
              </dd>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <dt className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Uptime
              </dt>
              <dd className="mt-1 truncate font-medium text-sm">
                {formatUptime(status.uptimeSeconds)}
              </dd>
            </div>
          </dl>
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

        <p className="mt-auto pt-6 text-center text-[10px] text-muted-foreground leading-4">
          The companion only observes Laborer. Closing it never stops daemon
          work.
        </p>
      </section>
    </main>
  );
};
