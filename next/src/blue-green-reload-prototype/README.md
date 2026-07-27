# Blue/green reload logic prototype

> THROWAWAY PROTOTYPE — this is an in-memory state-machine sketch, not daemon
> lifecycle code.

This prototype asks one question:

> Does a warm blue/green drain-and-swap let a prepared daemon generation take
> over queued work without allowing two generations to own durable state?

The production target is specified in
[Development daemon live reload](../../../docs/development-daemon-live-reload-spec.md).

It models the deliberately small version:

- one generation is active;
- a candidate can prepare without owning runtime state;
- reload makes the active generation drain;
- new work is queued while draining;
- the candidate activates only after the old generation has no in-flight work;
- a failed preparation leaves the active generation untouched.

It intentionally does not spawn processes, connect to Slack or ACP, persist
state, or implement active-active work routing.

Run the scripted proof:

```sh
bun run --cwd next prototype:blue-green-reload --scenario
```

Run the focused behavioral tests:

```sh
bun run --cwd next vitest run tests/blue-green-reload-prototype.test.ts
```

Run the interactive state machine:

```sh
bun run --cwd next prototype:blue-green-reload
```

The interactive commands are:

```text
work <id>
done <id>
prepare <generation>
prepare-fail <generation>
reload <generation>
state
reset
scenario
help
quit
```
