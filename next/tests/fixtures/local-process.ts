import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "echo";

if (mode === "echo") {
  const input = Buffer.concat(await Array.fromAsync(process.stdin));
  process.stdout.write(input);
  process.stderr.write("private diagnostic");
} else if (mode === "literal") {
  process.stdout.write(process.argv[3] ?? "");
} else if (mode === "input-length") {
  const input = Buffer.concat(await Array.fromAsync(process.stdin));
  process.stdout.write(String(input.byteLength));
} else if (mode === "exit") {
  process.exit(Number(process.argv[3] ?? "7"));
} else if (mode === "output") {
  const stream = process.argv[4] === "stderr" ? process.stderr : process.stdout;
  stream.write(Buffer.alloc(Number(process.argv[3] ?? "1024"), 0x78));
} else if (mode === "environment") {
  process.stdout.write(JSON.stringify(process.env));
} else if (mode === "hang-tree") {
  const descendant = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "process.on('SIGTERM', () => undefined); setInterval(() => {}, 1000)",
    ],
    { stdio: "ignore" }
  );
  process.stdout.write(String(descendant.pid));
  const pidFile = process.argv[3];
  if (pidFile !== undefined) {
    writeFileSync(pidFile, String(descendant.pid));
  }
  await new Promise(() => undefined);
} else if (mode === "exit-without-input") {
  process.exit(Number(process.argv[3] ?? "7"));
} else if (mode === "output-after-exit") {
  const descendant = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `process.on("SIGTERM", () => {
        process.stdout.write(Buffer.alloc(2048, 0x78));
      });
      process.send?.("ready");
      setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "inherit", "ignore", "ipc"] }
  );
  await new Promise<void>((resolveReady) => {
    descendant.once("message", () => resolveReady());
  });
  process.exit(0);
} else if (mode === "escaped-output-holder") {
  const descendant = spawn(
    process.execPath,
    ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: ["ignore", "inherit", "ignore"] }
  );
  process.stdout.write(String(descendant.pid));
  descendant.unref();
}
