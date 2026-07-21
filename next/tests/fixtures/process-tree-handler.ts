import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const mode = process.env.PROCESS_TREE_MODE ?? "normal";
if (mode === "early-close-stdin") {
  closeSync(0);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  process.exit(0);
}

let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  source += chunk;
}
const envelope = JSON.parse(source) as { readonly turnId: string };

if (mode === "invalid-utf8") {
  process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
  process.exit(0);
}
if (mode === "stdout-record-overflow") {
  const records = Array.from(
    { length: 4097 },
    () => '{"protocolVersion":1,"type":"unknown"}\n'
  ).join("");
  await new Promise<void>((resolveWrite) =>
    process.stdout.write(records, () => resolveWrite())
  );
  process.exit(0);
}
if (mode === "stdout-byte-overflow") {
  const payload = "x".repeat(900 * 1024);
  const records = Array.from(
    { length: 10 },
    () =>
      `${JSON.stringify({ payload, protocolVersion: 1, type: "unknown" })}\n`
  ).join("");
  await new Promise<void>((resolveWrite) =>
    process.stdout.write(records, () => resolveWrite())
  );
  process.exit(0);
}
if (mode === "stderr-throughput-overflow") {
  await new Promise<void>((resolveWrite) =>
    process.stderr.write(Buffer.alloc(8 * 1024 * 1024 + 1, 0x78), () =>
      resolveWrite()
    )
  );
  process.exit(0);
}
if (mode === "public-reply-excess") {
  process.stdout.write(
    `${JSON.stringify({
      extra: true,
      protocolVersion: 1,
      replyId: "reply:strict:1",
      text: "strict",
      type: "public_reply",
    })}\n`
  );
  process.exit(0);
}
if (mode === "public-reply-blank-id") {
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      replyId: "   ",
      text: "strict",
      type: "public_reply",
    })}\n`
  );
  process.exit(0);
}
if (mode === "unknown-excess") {
  process.stdout.write(
    `${JSON.stringify({ extra: true, protocolVersion: 1, type: "future" })}\n`
  );
  process.exit(0);
}

if (mode === "stderr-tail") {
  await new Promise<void>((resolveWrite) =>
    process.stderr.write(
      `discard-me:${"x".repeat(80 * 1024)}retained-tail-marker`,
      () => resolveWrite()
    )
  );
  await new Promise<void>((resolveWrite) =>
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        replyId: `reply:${envelope.turnId}:1`,
        text: "stderr retained",
        type: "public_reply",
      })}\n`,
      () => resolveWrite()
    )
  );
  process.exit(0);
}

const grandchildSource =
  mode === "descendant-race"
    ? "process.exit(0)"
    : "process.stdin.resume(); setInterval(() => undefined, 1000)";
const grandchild = spawn(
  process.execPath,
  ["--input-type=module", "--eval", grandchildSource],
  { stdio: ["ignore", "inherit", "inherit"] }
);
grandchild.unref();
const pidFile = process.env.PROCESS_TREE_PID_FILE;
if (pidFile !== undefined) {
  await writeFile(pidFile, String(grandchild.pid));
}

if (mode === "overflow") {
  process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x78));
  process.exit(0);
}
if (mode === "timeout") {
  await new Promise(() => undefined);
}

process.stdout.write(
  `${JSON.stringify({
    protocolVersion: 1,
    replyId: `reply:${envelope.turnId}:1`,
    text: "tree supervised",
    type: "public_reply",
  })}\n`
);
