#!/usr/bin/env bash

set -euo pipefail

[[ "${1:-}" == "acp" && "$#" -eq 1 ]] || exit 2

"${FAKE_ACP_RUNTIME:?}" -e '
  const fs = require("node:fs");
  const [path, ...args] = process.argv.slice(1);
  const kind = (fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.isFIFO()) return "fifo";
    if (stat.isSocket()) return "socket";
    if (stat.isFile()) return "file";
    if (stat.isCharacterDevice()) return "character";
    return "other";
  };
  fs.writeFileSync(path, JSON.stringify({
    args,
    cwd: process.cwd(),
    stdio: {
      stderr: { isTTY: Boolean(process.stderr.isTTY), kind: kind(2), writable: process.stderr.writable },
      stdin: { isTTY: Boolean(process.stdin.isTTY), kind: kind(0), readable: process.stdin.readable },
      stdout: { isTTY: Boolean(process.stdout.isTTY), kind: kind(1), writable: process.stdout.writable }
    }
  }));
' "${FAKE_ACP_LAUNCH_LOG:?}" "$@"

if [[ "${FAKE_ACP_MODE:-}" == "oversized-line" ]]; then
  exec "${FAKE_ACP_RUNTIME}" -e '
    const fs = require("node:fs");
    if (process.env.SCRIPTED_ACP_PID_PATH) {
      fs.writeFileSync(process.env.SCRIPTED_ACP_PID_PATH, String(process.pid));
    }
    process.stdin.resume();
    process.stdout.write("x".repeat(Number(process.env.FAKE_ACP_LINE_BYTES)));
    setInterval(() => undefined, 1000);
  '
fi

if [[ "${FAKE_ACP_MODE:-}" == "hang-startup" ]]; then
  exec "${FAKE_ACP_RUNTIME}" -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.env.SCRIPTED_ACP_PID_PATH, String(process.pid));
    process.stdin.resume();
    setInterval(() => undefined, 1000);
  '
fi

exec "${FAKE_ACP_RUNTIME}" "${FAKE_ACP_PEER:?}"
