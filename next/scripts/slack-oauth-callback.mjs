#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const callbackPath = "/slack/oauth/callback";
const callbackPort = 8787;
const redirectUri =
  "https://izaks-macbook-pro-1.tail08c37.ts.net/slack/oauth/callback";
const clientId = "1213883857746.11656547604037";
const expectedTeamId = "T04UDJP9283";
const clientSecretService = "laborer-slack-client-secret-steeple";
const botTokenService = "laborer-slack-bot-token-freckle";
const scriptPath = fileURLToPath(import.meta.url);
const runtimeRoot = resolve(dirname(scriptPath), "../.laborer-runtime");
const pidPath = resolve(runtimeRoot, "slack-oauth-callback.pid");
const logPath = resolve(runtimeRoot, "slack-oauth-callback.log");
const account = process.env.USER;

const fail = (message) => {
  throw new Error(message);
};

const keychainPassword = (service) => {
  if (account === undefined || account.length === 0) {
    return fail("USER is unavailable");
  }
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return fail(`Keychain credential unavailable: ${service}`);
  }
  return result.stdout.trim();
};

const storeToken = (token) => {
  const result = spawnSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      botTokenService,
      "-w",
      token,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    fail("Unable to rotate the Freckle bot token in Keychain");
  }
};

const respond = (response, status, message) => {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(`${message}\n`);
};

const readPid = () => {
  if (!existsSync(pidPath)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
};

const exchangeCode = async (code) => {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: keychainPassword(clientSecretService),
    code,
    redirect_uri: redirectUri,
  });
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await tokenResponse.json();
  if (
    typeof payload === "object" &&
    payload !== null &&
    payload.ok === true &&
    typeof payload.access_token === "string" &&
    payload.team?.id === expectedTeamId
  ) {
    return payload.access_token;
  }
  const reason =
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.error === "string"
      ? payload.error
      : "invalid-response";
  return fail(`Slack token exchange failed: ${reason}`);
};

const serve = () => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${callbackPort}`);
    if (request.method !== "GET" || url.pathname !== callbackPath) {
      respond(response, 404, "Not found.");
      return;
    }

    const slackError = url.searchParams.get("error");
    if (slackError !== null) {
      respond(response, 400, `Slack authorization failed: ${slackError}`);
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) {
      respond(response, 400, "OAuth callback is ready.");
      return;
    }

    try {
      storeToken(await exchangeCode(code));
      respond(
        response,
        200,
        "Laborer was reauthorized for Freckle and the bot token was stored in Keychain."
      );
      process.stdout.write("OAuth completed successfully.\n");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown OAuth error";
      process.stderr.write(`${message}\n`);
      respond(response, 500, message);
    }
  });

  const shutdown = () => {
    server.close(() => {
      if (readPid() === process.pid) {
        unlinkSync(pidPath);
      }
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(callbackPort, "127.0.0.1", () => {
    process.stdout.write(
      `Slack OAuth callback listening on 127.0.0.1:${callbackPort}.\n`
    );
  });
};

const start = async () => {
  mkdirSync(runtimeRoot, { mode: 0o700, recursive: true });
  chmodSync(runtimeRoot, 0o700);
  const existingPid = readPid();
  if (existingPid !== undefined && isRunning(existingPid)) {
    process.stdout.write(
      `Slack OAuth callback is already running (${existingPid}).\n`
    );
    return;
  }
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }

  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [scriptPath, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

  const ready = await waitFor(async () => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}${callbackPath}`
      );
      return response.status === 400;
    } catch {
      return false;
    }
  }, 3000);
  if (!ready) {
    if (isRunning(child.pid)) {
      process.kill(child.pid, "SIGTERM");
    }
    fail(`Slack OAuth callback failed to start; inspect ${logPath}`);
  }
  process.stdout.write(`Slack OAuth callback started (${child.pid}).\n`);
};

const stop = async () => {
  const pid = readPid();
  if (pid === undefined || !isRunning(pid)) {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
    process.stdout.write("Slack OAuth callback is already stopped.\n");
    return;
  }
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout.trim();
  if (!(command.includes(scriptPath) && command.endsWith(" serve"))) {
    fail(`Refusing to stop unrelated process ${pid}`);
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitFor(() => !isRunning(pid), 3000);
  if (!stopped) {
    fail(`Slack OAuth callback ${pid} did not stop cleanly`);
  }
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
  process.stdout.write("Slack OAuth callback stopped.\n");
};

const main = async () => {
  const action = process.argv[2];
  if (action === "start") {
    await start();
    return;
  }
  if (action === "stop") {
    await stop();
    return;
  }
  if (action === "serve") {
    serve();
    return;
  }
  fail("Usage: slack-oauth-callback.mjs <start|stop>");
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unable to manage Slack OAuth callback: ${message}\n`);
  process.exitCode = 1;
}
