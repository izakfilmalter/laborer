import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  type LucideIcon,
  Radio,
} from "lucide-react";
import type { OperatorStatusView } from "../../operator-status/client.ts";
import { Button } from "./components/ui/button.tsx";

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
  return `${minutes}m`;
};

const statusPresentation: Record<
  OperatorStatusView["state"],
  {
    readonly description: string;
    readonly icon: LucideIcon;
    readonly pending: boolean;
    readonly title: string;
  }
> = {
  connecting: {
    description: "Looking for the local Laborer daemon.",
    icon: LoaderCircle,
    pending: true,
    title: "Connecting…",
  },
  incompatible: {
    description: "The companion and daemon use incompatible protocol versions.",
    icon: AlertCircle,
    pending: false,
    title: "Update required",
  },
  reconnecting: {
    description: "Looking for the local Laborer daemon.",
    icon: LoaderCircle,
    pending: true,
    title: "Reconnecting…",
  },
  running: {
    description: "Laborer is connected and ready for Slack work.",
    icon: CheckCircle2,
    pending: false,
    title: "Daemon running",
  },
  unavailable: {
    description:
      "Laborer cannot reach the local daemon. Existing work is not stopped.",
    icon: Radio,
    pending: false,
    title: "Daemon unavailable",
  },
};

export const StatusPopover = ({
  reconnect,
  status,
}: {
  readonly reconnect: () => void;
  readonly status: OperatorStatusView;
}) => {
  const presentation = statusPresentation[status.state];
  const unavailable = status.state === "unavailable";
  const incompatible = status.state === "incompatible";
  const Icon = presentation.icon;

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-border border-b px-5 py-4">
        <div>
          <h1 className="font-semibold text-base tracking-tight">Laborer</h1>
          <p className="text-muted-foreground text-xs">Local companion</p>
        </div>
        <span className="rounded-full border border-border bg-surface px-2 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          Daemon
        </span>
      </header>

      <section
        aria-labelledby="daemon-status-title"
        className="flex flex-1 flex-col p-5"
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 rounded-full p-2 ${status.state === "running" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
          >
            <Icon
              aria-hidden="true"
              className={
                presentation.pending ? "size-5 animate-spin" : "size-5"
              }
            />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-sm" id="daemon-status-title">
              {presentation.title}
            </h2>
            <output className="mt-1 text-muted-foreground text-xs leading-5">
              {presentation.description}
            </output>
          </div>
        </div>

        {status.state === "running" ? (
          <dl className="mt-6 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border bg-surface p-3">
              <dt className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Version
              </dt>
              <dd className="mt-1 font-mono text-sm">{status.version}</dd>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <dt className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Uptime
              </dt>
              <dd className="mt-1 font-medium text-sm">
                {formatUptime(status.uptimeSeconds)}
              </dd>
            </div>
          </dl>
        ) : null}

        {unavailable || incompatible ? (
          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <p className="text-muted-foreground text-xs leading-5">
              {incompatible
                ? "Update either Laborer component, then check the connection again."
                : "Start the daemon separately, then retry. Closing this companion never ends daemon work."}
            </p>
            <Button className="mt-3 w-full" onClick={reconnect}>
              {incompatible ? "Check again" : "Try again"}
            </Button>
          </div>
        ) : null}

        <p className="mt-auto pt-6 text-center text-[10px] text-muted-foreground">
          The companion observes Laborer; it does not own daemon work.
        </p>
      </section>
    </main>
  );
};
