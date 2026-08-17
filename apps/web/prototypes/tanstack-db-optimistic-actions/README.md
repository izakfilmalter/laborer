# THROWAWAY: TanStack DB optimistic actions for Laborer #551

## Question

Can Laborer make every mutating task and project intent optimistic with TanStack DB 0.7.2 while following upstream's action and pacing APIs for RPC/stream confirmation races, same-row ordered writes, and atomic multi-row rejection? This is executable contract evidence, not a production adapter or abstraction. Ordinary single intents use named `createOptimisticAction` actions, same-row concurrency uses upstream `createPacedMutations`, and project reorder uses one action for the whole atomic multi-row intent.

## Run

From `apps/web`:

```sh
bun run prototype:tanstack-actions
```

## Observed Verdicts

1. **Same-row RPC then stream: pass.** `onMutate` is synchronous. After the RPC returns, the transaction remains `persisting` and the optimistic row remains visible because `mutationFn` waits for the matching authoritative stream transaction. Once that transaction is applied and observed, TanStack retires optimism without a flashback.
2. **Project add: pass.** A project is inserted synchronously and remains visible after RPC success while its authoritative stream transaction is pending. The streamed project then replaces the optimistic insert. This confirms adds follow the same optimistic contract as every other Laborer mutation.
3. **Overlapping same-row writes: pass with upstream FIFO pacing.** One stable `createPacedMutations` manager with `queueStrategy({ addItemsTo: 'back', getItemsFrom: 'front' })` creates a separate optimistic transaction for each call. A then B immediately shows B, but only A's `mutationFn` runs. B starts only after A's RPC and matching stream confirmation complete. B obtains `expectedRevision` inside `mutationFn` from the latest authoritative confirmation; the scenario deliberately advances server revisions from 1 to 7 to 11 rather than assuming `revision + 1`.
4. **Multi-row project reorder rejection: pass.** One `createOptimisticAction` creates one TanStack transaction containing all three row mutations. A definitive server error fails that transaction and rolls every row back together.
5. **Stream before RPC: pass with a level-triggered waiter.** Recording observed transaction IDs makes a later `awaitTxId` resolve immediately. The early authoritative row stays beneath the optimistic layer until the RPC supplies its matching ID, then becomes visible safely.

## Upstream Queue Scope

`@tanstack/db` scopes each queue to one `createPacedMutations` manager or `usePacedMutations` hook instance. Production should therefore keep a stable manager per row/key when concurrency should be ordered per row, or intentionally share a manager when a broader queue is desired. This is upstream queue scoping, not custom optimistic ownership or a Laborer scheduler. TanStack owns optimistic layering, transaction rollback, and FIFO persistence; Laborer still supplies its RPC and stream-correlation contract and reads authoritative revisions at persistence time.

## Notes

- The in-memory `AuthoritativeTransactions` helper only models Electric-style `awaitTxId`: `mutationFn` does not return until the matching streamed transaction has been applied.
- Every demonstrated intent is optimistic. Ordinary single intents remain named `createOptimisticAction` actions, while only ordered overlap uses upstream pacing and atomic reorder remains one multi-row action.
- The prototype intentionally has deterministic scenario output instead of a polished interactive TUI.
- Delete this directory rather than importing it into production code.
