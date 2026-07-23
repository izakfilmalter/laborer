# User-authored Action toolkit prototype

> THROWAWAY PROTOTYPE for the Wayfinder ticket “Prototype the user-authored conversation toolkit API.”

## Question

Does one Effect-native application definition feel like a pleasant authoring surface when it combines a fully user-controlled conversation-agent factory with a static catalog of asynchronous Actions, then derives both model-facing instructions and a machine-readable CLI from that catalog?

This prototype deliberately does not run OpenCode or implement the durable runtime. It uses a scratch state file named `.action-toolkit-prototype-state.json` to make the proposed `list`, `describe`, `start`, and `get` interactions tangible. The prototype-only `advance` command stands in for the separately owned execution runtime.

## Run it

```bash
bun run --cwd next prototype:actions demo
```

Inspect individual commands with:

```bash
bun run --cwd next prototype:actions --help
```

The author-facing definition is in `example-application.ts`. The transport-neutral composition surface is in `toolkit.ts`.
