import { createFileRoute } from "@tanstack/react-router";
import { StatusPopover } from "../status-popover.tsx";
import { useOperatorStatus } from "../status-store.ts";

const StatusRoute = () => {
  const status = useOperatorStatus();
  return (
    <StatusPopover
      quit={() => window.laborerCompanion.quit().catch(() => undefined)}
      reconnect={() =>
        window.laborerCompanion.reconnect().catch(() => undefined)
      }
      status={status}
    />
  );
};

export const Route = createFileRoute("/")({ component: StatusRoute });
