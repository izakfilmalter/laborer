/** THROWAWAY ISSUE #204 PROTOTYPE child process fixture. */
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const waitForever = (): Promise<void> =>
  new Promise(() => {
    setInterval(() => undefined, 1000);
  });

const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
let json = "";
for await (const line of input) {
  json += line;
}
const envelope = JSON.parse(json) as {
  readonly messages: readonly {
    readonly classification: "context" | "input";
    readonly text: string;
  }[];
  readonly protocolVersion: number;
  readonly stateDirectory: string;
  readonly turnId: string;
};
if (envelope.protocolVersion !== 1) {
  process.exitCode = 2;
} else {
  const inputs = envelope.messages.filter(
    (message) => message.classification === "input"
  );
  const text = inputs.map((message) => message.text).join(" | ");
  const match = /\[fixture:delay=(\d+)\]/u.exec(text);
  if (match?.[1] !== undefined) {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, Number(match[1]))
    );
  }
  const reply = (index: number, replyText: string) => ({
    protocolVersion: 1,
    type: "public_reply",
    replyId: `reply:${envelope.turnId}:${index}`,
    text: replyText,
  });
  const write = (record: unknown) =>
    process.stdout.write(`${JSON.stringify(record)}\n`);
  process.stderr.write(`SECRET internal diagnostics for ${envelope.turnId}\n`);

  if (!text.includes("[fixture:no-reply]")) {
    const first = reply(1, `[PUBLIC ${envelope.turnId}:1] ${text}`);
    write(first);
    if (text.includes("[fixture:two]")) {
      write(reply(2, `[PUBLIC ${envelope.turnId}:2] second`));
    }
    if (text.includes("[fixture:duplicate]")) {
      write(first);
    }
    if (text.includes("[fixture:conflict]")) {
      write({ ...first, text: "conflicting content" });
    }
  }
  if (text.includes("[fixture:unknown]")) {
    write({ protocolVersion: 1, type: "internal_metric", value: 1 });
  }
  if (text.includes("[fixture:malformed]")) {
    process.stdout.write("not-json\n");
  }
  if (text.includes("[fixture:oversized-unterminated]")) {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
  }
  if (text.includes("[fixture:inherited-pipe]")) {
    const descendant = spawn(
      process.execPath,
      ["-e", "setTimeout(() => undefined, 3000)"],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    descendant.unref();
  }
  if (text.includes("[fixture:reply-then-interrupt]")) {
    const marker = resolve(envelope.stateDirectory, "reply-emitted-once");
    let markerExists = true;
    try {
      await access(marker);
    } catch {
      markerExists = false;
    }
    if (!markerExists) {
      await writeFile(marker, "emitted", { mode: 0o600 });
      await waitForever();
    }
  }
  if (text.includes("[fixture:signal]")) {
    process.kill(process.pid, "SIGTERM");
    await waitForever();
  }
  if (text.includes("[fixture:term-resistant]")) {
    process.on("SIGTERM", () => undefined);
    await waitForever();
  }
  if (text.includes("[fixture:exit-1]")) {
    process.exitCode = 7;
  }
}
