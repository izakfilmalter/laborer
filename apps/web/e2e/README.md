# Mission control end-to-end tests

`bun run test:e2e` starts an isolated Vite server and fixture-owned daemon. The
daemon gets a bind-then-release ephemeral port and fresh state home; browser
journeys seed only through public RPCs.

Set `LABORER_E2E_REUSE_DEV_STACK=1` to opt into an already-running Vite + daemon
stack while debugging with Playwright `--ui`, `--headed`, or `--debug`. Set
`VITE_PORT` and `LABORER_DAEMON_PORT` when that stack does not use 2101/2100.
Restart/disconnect journeys are skipped in this mode because tests never stop a
developer-owned daemon; normal `test:e2e` always runs all four against isolation.
