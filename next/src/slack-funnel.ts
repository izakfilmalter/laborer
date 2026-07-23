import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CALLBACK_PATH = "/slack/oauth/callback";
const CALLBACK_PORT = 8787;
const MACOS_TAILSCALE_PATH =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const SLACK_APP_MANAGEMENT_URL = "https://api.slack.com/apps";
const TRAILING_DOT_PATTERN = /\.$/;

type FunnelAction = "off" | "on" | "status";

interface TailscaleStatus {
  readonly Self?: {
    readonly DNSName?: string;
  };
}

const resolveTailscaleCommand = (): string => {
  const configuredCommand = process.env.TAILSCALE_BIN?.trim();
  if (configuredCommand !== undefined && configuredCommand.length > 0) {
    return configuredCommand;
  }
  return existsSync(MACOS_TAILSCALE_PATH) ? MACOS_TAILSCALE_PATH : "tailscale";
};

const runTailscale = (args: readonly string[]): string => {
  const result = spawnSync(resolveTailscaleCommand(), args, {
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      details.length > 0
        ? details
        : `Tailscale exited with status ${result.status ?? "unknown"}`
    );
  }
  return result.stdout.trim();
};

const runTailscaleInteractive = (args: readonly string[]): void => {
  const result = spawnSync(resolveTailscaleCommand(), args, {
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Tailscale exited with status ${result.status ?? "unknown"}`
    );
  }
};

const parseObject = (source: string, operation: string): object => {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value;
    }
  } catch {
    // The operation-specific error below is more useful than a JSON stack trace.
  }
  throw new Error(`Tailscale returned invalid JSON while ${operation}`);
};

const getPublicHostname = (): string => {
  const status = parseObject(
    runTailscale(["status", "--json"]),
    "reading node status"
  ) as TailscaleStatus;
  const dnsName = status.Self?.DNSName?.replace(TRAILING_DOT_PATTERN, "");
  if (dnsName === undefined || dnsName.length === 0) {
    throw new Error("Tailscale did not report a MagicDNS hostname");
  }
  return dnsName;
};

const funnelIsEnabled = (): boolean =>
  Object.keys(
    parseObject(
      runTailscale(["funnel", "status", "--json"]),
      "reading Funnel status"
    )
  ).length > 0;

const printFunnelDetails = (): void => {
  const hostname = getPublicHostname();
  process.stdout.write(
    [
      `Callback URL: https://${hostname}${CALLBACK_PATH}`,
      `Local target: http://127.0.0.1:${CALLBACK_PORT}`,
      `Slack app settings: ${SLACK_APP_MANAGEMENT_URL}`,
      "Disable Funnel: bun run slack:funnel:off",
      "",
    ].join("\n")
  );
};

const enableFunnel = (): void => {
  runTailscaleInteractive(["funnel", "--bg", "--yes", String(CALLBACK_PORT)]);
  process.stdout.write("Slack OAuth Funnel enabled.\n");
  printFunnelDetails();
};

const disableFunnel = (): void => {
  if (!funnelIsEnabled()) {
    process.stdout.write("Slack OAuth Funnel is already disabled.\n");
    return;
  }
  runTailscale(["funnel", "reset"]);
  process.stdout.write("Slack OAuth Funnel disabled.\n");
};

const printFunnelStatus = (): void => {
  if (!funnelIsEnabled()) {
    process.stdout.write("Slack OAuth Funnel is disabled.\n");
    return;
  }
  process.stdout.write("Slack OAuth Funnel is enabled.\n");
  printFunnelDetails();
};

const parseAction = (value: string | undefined): FunnelAction => {
  if (value === "off" || value === "on" || value === "status") {
    return value;
  }
  throw new Error(
    "Usage: bun run slack:funnel <on|off|status> (or use slack:funnel:on/off/status)"
  );
};

const main = (): void => {
  const action = parseAction(process.argv[2]);
  if (action === "on") {
    enableFunnel();
    return;
  }
  if (action === "off") {
    disableFunnel();
    return;
  }
  printFunnelStatus();
};

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Unable to manage Slack OAuth Funnel: ${message}\n`);
    process.exitCode = 1;
  }
}
