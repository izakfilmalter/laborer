import { appendFileSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";

const [pidPath, releasePath, signalPath, label] = process.argv.slice(2);
if (pidPath && releasePath && signalPath && label) {
  await writeFile(pidPath, String(process.pid), { flag: "wx", mode: 0o600 });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      appendFileSync(signalPath, `${signal}\n`, { mode: 0o600 });
    });
  }
  const interval = setInterval(async () => {
    const released = await access(releasePath).then(
      () => true,
      () => false
    );
    if (!released) {
      return;
    }
    clearInterval(interval);
    process.stdout.write(`${JSON.stringify({ artifact: label })}\n`);
  }, 10);
} else {
  process.exitCode = 2;
}
