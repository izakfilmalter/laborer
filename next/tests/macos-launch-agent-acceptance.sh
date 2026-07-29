#!/bin/sh
set -eu

if [ "${LABORER_MACOS_ACCEPTANCE:-}" != "1" ] || [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Set LABORER_MACOS_ACCEPTANCE=1 on macOS to run this acceptance.'
  exit 0
fi

case "$(uname -m)" in
  arm64) artifact_arch=arm64 ;;
  x86_64) artifact_arch=x64 ;;
  *) printf '%s\n' 'Unsupported macOS architecture.' >&2; exit 1 ;;
esac

app="release/macos-$artifact_arch/Laborer.app"
helper="$app/Contents/Resources/service-management"
label="com.laborer.daemon"
companion_pid=""
service_enabled=0

cleanup() {
  if [ -n "$companion_pid" ]; then
    kill "$companion_pid" >/dev/null 2>&1 || true
  fi
  if [ "$service_enabled" = "1" ]; then
    "$helper" unregister >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

bun run companion:package:macos
open "$app"

attempt=0
while [ "$attempt" -lt 30 ]; do
  state="$($helper status)"
  case "$state" in
    *'"state":"enabled"'*) break ;;
    *'"state":"requires-approval"'*)
      printf '%s\n' 'Approve Laborer in System Settings > General > Login Items, then rerun.' >&2
      exit 2
      ;;
    *'"state":"denied"'*)
      printf '%s\n' 'macOS denied LaunchAgent registration.' >&2
      exit 2
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 1
done

launchctl print "gui/$UID/$label" >/dev/null
service_enabled=1
daemon_command="$app/Contents/Resources/daemon/app/src/slack/live.ts"
daemon_pid="$(pgrep -f "$daemon_command" | head -n 1)"
companion_pid="$(pgrep -f "$app/Contents/MacOS/Laborer" | head -n 1)"
test -n "$daemon_pid"
test -n "$companion_pid"

# A companion crash must not terminate or replace the launchd-owned daemon.
kill -9 "$companion_pid"
companion_pid=""
sleep 2
kill -0 "$daemon_pid"

# Reopening adopts the existing service rather than starting another daemon.
open "$app"
sleep 2
companion_pid="$(pgrep -f "$app/Contents/MacOS/Laborer" | head -n 1)"
test -n "$companion_pid"
test "$(pgrep -f "$daemon_command" | wc -l | tr -d ' ')" = "1"

# SIGTERM enters the daemon's scoped shutdown; KeepAlive then makes launchd,
# rather than the companion, start its replacement under the login policy.
kill -TERM "$daemon_pid"
attempt=0
replacement_pid=""
while [ "$attempt" -lt 30 ]; do
  replacement_pid="$(pgrep -f "$daemon_command" | head -n 1 || true)"
  if [ -n "$replacement_pid" ] && [ "$replacement_pid" != "$daemon_pid" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test -n "$replacement_pid"
test "$replacement_pid" != "$daemon_pid"
launchctl print "gui/$UID/$label" >/dev/null

kill "$companion_pid"
companion_pid=""
"$helper" unregister >/dev/null
service_enabled=0
attempt=0
while [ "$attempt" -lt 10 ] && launchctl print "gui/$UID/$label" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  sleep 1
done
if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
  printf '%s\n' 'LaunchAgent remained loaded after unregister.' >&2
  exit 1
fi

trap - EXIT INT TERM
printf '%s\n' 'macOS LaunchAgent acceptance passed.'
