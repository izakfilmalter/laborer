# Effect 4 migration follow-ups

The migration specified in GitHub issue #436 intentionally preserved behavior where Effect 4 did not force a rewrite. The following lifecycle and renderer improvements remain separate follow-up work; they were not part of the migration:

- Add structured cancellation for root fibers launched from callbacks so their ownership and shutdown behavior are explicit.
- Dispose `ManagedRuntime` instances during signal-driven shutdown.
- Review the scope ownership of forks migrated from former daemon forks.
- Replace the raw heartbeat sentinel with RPC `Ping` and `Pong` messages if the protocol is deliberately upgraded.
- Cancel renderer terminal-spawn work when its owning component unmounts, after defining the intended user-visible semantics.
- Evaluate a renderer-wide structural query cache instead of relying only on call-site memoization.
- If independent command call sites proliferate, adopt a per-invocation `AtomCommand` abstraction with parallel execution rather than adding more runtime bridges.

Each item requires its own behavioral specification and tests. Do not fold these changes into maintenance work merely because the application now uses Effect 4.
