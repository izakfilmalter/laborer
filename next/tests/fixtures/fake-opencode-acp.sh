#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "debug" && "${2:-}" == "config" && "$#" -eq 2 ]]; then
  if [[ -n "${FAKE_OPENCODE_CONFIG_PROBE_OBSERVATION_PATH:-}" ]]; then
    "${FAKE_ACP_RUNTIME:?}" -e '
      const fs = require("node:fs");
      fs.writeFileSync(process.env.FAKE_OPENCODE_CONFIG_PROBE_OBSERVATION_PATH, JSON.stringify({
        args: process.argv.slice(1),
        cwd: process.cwd(),
        environmentNames: Object.keys(process.env).sort()
      }));
    ' "$@"
  fi
  case "${FAKE_OPENCODE_CONFIG_PROBE_MODE:-ok}" in
    malformed)
      printf '{"private":"%s"' "${FAKE_OPENCODE_CONFIG_PROBE_SECRET:-private}"
      exit 0
      ;;
    nonzero)
      printf '%s' "${FAKE_OPENCODE_CONFIG_PROBE_SECRET:-probe-failed}" >&2
      exit 7
      ;;
    oversize)
      "${FAKE_ACP_RUNTIME:?}" -e 'process.stdout.write("x".repeat(Number(process.env.FAKE_OPENCODE_CONFIG_PROBE_BYTES)))'
      exit 0
      ;;
    timeout)
      "${FAKE_ACP_RUNTIME:?}" -e 'setInterval(() => undefined, 1000)'
      ;;
    ok)
      if [[ -n "${FAKE_OPENCODE_WELL_KNOWN_CONFIG_JSON:-}${FAKE_OPENCODE_ACCOUNT_CONFIG_JSON:-}${FAKE_OPENCODE_OS_MANAGED_CONFIG_JSON:-}" ]]; then
        "${FAKE_ACP_RUNTIME:?}" -e '
          const sources = [
            process.env.FAKE_OPENCODE_WELL_KNOWN_CONFIG_JSON,
            process.env.FAKE_OPENCODE_ACCOUNT_CONFIG_JSON,
            process.env.FAKE_OPENCODE_OS_MANAGED_CONFIG_JSON
          ];
          const result = {};
          for (const source of sources) {
            if (!source) continue;
            const next = JSON.parse(source);
            const priorMcp = result.mcp;
            Object.assign(result, next);
            if (next.mcp) result.mcp = { ...(priorMcp || {}), ...next.mcp };
          }
          process.stdout.write(JSON.stringify(result));
        '
      elif [[ -n "${SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON:-}" ]]; then
        printf '%s' "${SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON}"
      else
        printf '%s' '{}'
      fi
      exit 0
      ;;
    *)
      exit 8
      ;;
  esac
fi

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
    environmentNames: Object.keys(process.env).sort(),
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
