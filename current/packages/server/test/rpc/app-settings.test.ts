import { assert, describe, it } from '@effect/vitest'
import { Effect, Either, Exit, type Scope } from 'effect'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

const runWithRpcTestContext = <A, E>(
  run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* makeScopedTestRpcContext
    return yield* run(context)
  }) as Effect.Effect<A, E, Scope.Scope>

describe('LaborerRpcs app settings', () => {
  it.scoped('round-trips the GitHub token through revision CAS', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const created = yield* client.appSetting.set({
          expectedRevision: 0,
          key: 'github_desktop_token',
          mutationId: 'github-connect',
          value: 'token-one',
        })
        const updated = yield* client.appSetting.set({
          expectedRevision: created.row.revision,
          key: created.row.key,
          mutationId: 'github-refresh',
          value: 'token-two',
        })

        assert.strictEqual(updated.row.value, 'token-two')
        assert.strictEqual(updated.row.revision, 2)
        assert.strictEqual(
          database.findSetting('github_desktop_token')?.value,
          'token-two'
        )
        assert.deepStrictEqual(
          database.stateChangesAfter(0).map(({ mutationId }) => mutationId),
          ['github-connect', 'github-refresh']
        )
      })
    )
  )

  it.scoped('rejects a stale settings writer without changing the value', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const created = yield* client.appSetting.set({
          expectedRevision: 0,
          key: 'github_desktop_token',
          mutationId: 'github-connect',
          value: 'token-one',
        })
        yield* client.appSetting.set({
          expectedRevision: created.row.revision,
          key: created.row.key,
          mutationId: 'other-writer',
          value: 'token-two',
        })

        const stale = yield* client.appSetting
          .set({
            expectedRevision: created.row.revision,
            key: created.row.key,
            mutationId: 'stale-writer',
            value: 'stale-token',
          })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(stale))
        if (Either.isLeft(stale)) {
          assert.strictEqual(stale.left.code, 'CAS_CONFLICT')
        }
        assert.strictEqual(
          database.findSetting(created.row.key)?.value,
          'token-two'
        )
        assert.strictEqual(database.stateChangesAfter(0).length, 2)
      })
    )
  )

  it.scoped('rejects oversized setting values at the RPC boundary', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const result = yield* client.appSetting
          .set({
            expectedRevision: 0,
            key: 'github_desktop_token',
            mutationId: 'oversized-setting',
            value: 'x'.repeat(16_385),
          })
          .pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(result))
        assert.isNull(database.findSetting('github_desktop_token'))
      })
    )
  )
})
