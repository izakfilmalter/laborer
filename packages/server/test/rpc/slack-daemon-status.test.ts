import { assert, describe, it } from '@effect/vitest'
import { SlackDaemonRpcs } from '@laborer/shared/rpc'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { RpcTest } from 'effect/unstable/rpc'
import { SlackDaemonRpcsLive } from '../../src/rpc/slack-daemon-handlers.js'
import {
  makeProcessInspector,
  ProcessInspectionError,
  ProcessInspector,
  type ProcessQuery,
  ProcessSignalError,
} from '../../src/services/process-inspector.js'
import {
  type DetachedProcessLaunch,
  ProcessLaunchError,
  ProcessLauncher,
} from '../../src/services/process-launcher.js'
import {
  SlackDaemonProcessControl,
  SOURCE_LABORER_CHECKOUT,
  SOURCE_SLACK_DAEMON_COMMAND,
  SOURCE_SLACK_DAEMON_LAUNCH,
} from '../../src/services/slack-daemon-process-control.js'

const PINNED_NODE_PATH_PATTERN = /\.nvm\/versions\/node\/v24\.11\.1\/bin/

const processControlLayer = (
  matchingPids: (
    query: ProcessQuery
  ) => Effect.Effect<readonly number[], ProcessInspectionError>,
  launchDetached: (
    launch: DetachedProcessLaunch
  ) => Effect.Effect<void, ProcessLaunchError>,
  signalIfMatching: (
    pid: number,
    query: ProcessQuery,
    signal: 'SIGTERM'
  ) => Effect.Effect<
    boolean,
    ProcessInspectionError | ProcessSignalError
  > = () => Effect.succeed(true)
) =>
  SlackDaemonProcessControl.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          ProcessInspector,
          ProcessInspector.of({ matchingPids, signalIfMatching })
        ),
        Layer.succeed(ProcessLauncher, ProcessLauncher.of({ launchDetached }))
      )
    )
  )

const clientFor = (layer: Layer.Layer<SlackDaemonProcessControl>) =>
  RpcTest.makeClient(SlackDaemonRpcs).pipe(
    Effect.provide(SlackDaemonRpcsLive.pipe(Layer.provide(layer)))
  )

describe('SlackDaemonRpcs', () => {
  it.effect('reports a running source daemon using the canonical query', () =>
    Effect.gen(function* () {
      let inspected: ProcessQuery | undefined
      const client = yield* clientFor(
        processControlLayer(
          (query) =>
            Effect.sync(() => {
              inspected = query
              return [101]
            }),
          () => Effect.void
        )
      )

      assert.deepStrictEqual(yield* client['slackDaemon.status'](), {
        status: 'running',
      })
      assert.deepStrictEqual(inspected, {
        commandPath: SOURCE_SLACK_DAEMON_COMMAND,
        cwd: SOURCE_LABORER_CHECKOUT,
      })
    })
  )

  it.effect('reports error instead of stopped when inspection fails', () =>
    Effect.gen(function* () {
      const client = yield* clientFor(
        processControlLayer(
          () =>
            new ProcessInspectionError({
              message: 'ps unavailable',
            }),
          () => Effect.void
        )
      )

      assert.deepStrictEqual(yield* client['slackDaemon.status'](), {
        status: 'error',
      })
    })
  )

  it.effect('does not launch when the daemon is already running', () =>
    Effect.gen(function* () {
      let launchCount = 0
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([101]),
          () =>
            Effect.sync(() => {
              launchCount += 1
            })
        )
      )

      assert.deepStrictEqual(yield* client['slackDaemon.start'](), {
        status: 'running',
      })
      assert.strictEqual(launchCount, 0)
    })
  )

  it.effect('launches once and waits for delayed daemon appearance', () =>
    Effect.gen(function* () {
      let launch: DetachedProcessLaunch | undefined
      let inspectionCount = 0
      const client = yield* clientFor(
        processControlLayer(
          () =>
            Effect.sync(() => {
              inspectionCount += 1
              return inspectionCount > 4 ? [101] : []
            }),
          (nextLaunch) =>
            Effect.sync(() => {
              launch = nextLaunch
            })
        )
      )

      const startFiber = yield* Effect.forkChild(client['slackDaemon.start']())
      yield* TestClock.adjust('400 millis')
      assert.deepStrictEqual(yield* Fiber.join(startFiber), {
        status: 'running',
      })
      assert.deepStrictEqual(launch, SOURCE_SLACK_DAEMON_LAUNCH)
      assert.strictEqual(inspectionCount, 5)
    })
  )

  it.effect('serializes concurrent starts and launches only once', () =>
    Effect.gen(function* () {
      const launchStarted = yield* Deferred.make<void>()
      const releaseLaunch = yield* Deferred.make<void>()
      let launchCount = 0
      let running = false
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed(running ? [101] : []),
          () =>
            Effect.gen(function* () {
              launchCount += 1
              yield* Deferred.succeed(launchStarted, undefined)
              yield* Deferred.await(releaseLaunch)
              running = true
            })
        )
      )

      const first = yield* Effect.forkChild(client['slackDaemon.start']())
      yield* Deferred.await(launchStarted)
      const second = yield* Effect.forkChild(client['slackDaemon.start']())
      yield* Deferred.succeed(releaseLaunch, undefined)
      yield* TestClock.adjust('100 millis')

      assert.deepStrictEqual(yield* Fiber.join(first), { status: 'running' })
      assert.deepStrictEqual(yield* Fiber.join(second), { status: 'running' })
      assert.strictEqual(launchCount, 1)
    })
  )

  it.effect('returns a sanitized start error after the bounded wait', () =>
    Effect.gen(function* () {
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([]),
          () => Effect.void
        )
      )

      const startFiber = yield* Effect.forkChild(client['slackDaemon.start']())
      yield* TestClock.adjust('10 seconds')
      const error = yield* Effect.flip(Fiber.join(startFiber))
      assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {
        _tag: 'SlackDaemonStartError',
        code: 'SLACK_DAEMON_START_FAILED',
        message: 'Unable to start Slack daemon.',
      })
    })
  )

  it.effect('returns only a sanitized expected error when launch fails', () =>
    Effect.gen(function* () {
      const credential = 'credential-value-that-must-not-cross-rpc'
      const layer = processControlLayer(
        () => Effect.succeed([]),
        () => new ProcessLaunchError({ message: credential })
      )
      const serviceError = yield* Effect.gen(function* () {
        const control = yield* SlackDaemonProcessControl
        return yield* Effect.flip(control.start())
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(JSON.parse(JSON.stringify(serviceError)), {
        _tag: 'SlackDaemonControlError',
        message: 'Unable to start Slack daemon',
      })
      assert.isFalse(JSON.stringify(serviceError).includes(credential))

      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([]),
          () => new ProcessLaunchError({ message: credential })
        )
      )

      const error = yield* Effect.flip(client['slackDaemon.start']())
      assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {
        _tag: 'SlackDaemonStartError',
        code: 'SLACK_DAEMON_START_FAILED',
        message: 'Unable to start Slack daemon.',
      })
      assert.isFalse(JSON.stringify(error).includes(credential))
    })
  )

  it.effect('stops every exact matching PID with SIGTERM', () =>
    Effect.gen(function* () {
      const signals: Array<readonly [number, 'SIGTERM']> = []
      let running = true
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed(running ? [101, 202] : []),
          () => Effect.void,
          (pid, _query, signal) =>
            Effect.sync(() => {
              signals.push([pid, signal])
              if (signals.length === 2) {
                running = false
              }
              return true
            })
        )
      )

      const stopFiber = yield* Effect.forkChild(client['slackDaemon.stop']())
      yield* TestClock.adjust('100 millis')
      assert.deepStrictEqual(yield* Fiber.join(stopFiber), {
        status: 'stopped',
      })
      assert.deepStrictEqual(signals, [
        [101, 'SIGTERM'],
        [202, 'SIGTERM'],
      ])
    })
  )

  it.effect('is idempotent when the daemon is already stopped', () =>
    Effect.gen(function* () {
      let signalCount = 0
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([]),
          () => Effect.void,
          () =>
            Effect.sync(() => {
              signalCount += 1
              return true
            })
        )
      )

      assert.deepStrictEqual(yield* client['slackDaemon.stop'](), {
        status: 'stopped',
      })
      assert.strictEqual(signalCount, 0)
    })
  )

  it.effect('serializes stop behind an in-flight start', () =>
    Effect.gen(function* () {
      const launchStarted = yield* Deferred.make<void>()
      const releaseLaunch = yield* Deferred.make<void>()
      const events: string[] = []
      let running = false
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed(running ? [101] : []),
          () =>
            Effect.gen(function* () {
              events.push('launch-started')
              yield* Deferred.succeed(launchStarted, undefined)
              yield* Deferred.await(releaseLaunch)
              running = true
              events.push('launch-finished')
            }),
          () =>
            Effect.sync(() => {
              events.push('signaled')
              running = false
              return true
            })
        )
      )

      const startFiber = yield* Effect.forkChild(client['slackDaemon.start']())
      yield* Deferred.await(launchStarted)
      const stopFiber = yield* Effect.forkChild(client['slackDaemon.stop']())
      assert.deepStrictEqual(events, ['launch-started'])

      yield* Deferred.succeed(releaseLaunch, undefined)
      yield* TestClock.adjust('200 millis')
      assert.deepStrictEqual(yield* Fiber.join(startFiber), {
        status: 'running',
      })
      assert.deepStrictEqual(yield* Fiber.join(stopFiber), {
        status: 'stopped',
      })
      assert.deepStrictEqual(events, [
        'launch-started',
        'launch-finished',
        'signaled',
      ])
    })
  )

  it.effect('returns a sanitized stop error when SIGTERM fails', () =>
    Effect.gen(function* () {
      const credential = 'credential-value-that-must-not-cross-stop-rpc'
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([101]),
          () => Effect.void,
          () => new ProcessSignalError({ message: credential })
        )
      )

      const error = yield* Effect.flip(client['slackDaemon.stop']())
      assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {
        _tag: 'SlackDaemonStopError',
        code: 'SLACK_DAEMON_STOP_FAILED',
        message: 'Unable to stop Slack daemon.',
      })
      assert.isFalse(JSON.stringify(error).includes(credential))
    })
  )

  it.effect('waits for delayed process disappearance after SIGTERM', () =>
    Effect.gen(function* () {
      let inspections = 0
      const client = yield* clientFor(
        processControlLayer(
          () =>
            Effect.sync(() => {
              inspections += 1
              return inspections > 30 ? [] : [101]
            }),
          () => Effect.void
        )
      )

      const stopFiber = yield* Effect.forkChild(client['slackDaemon.stop']())
      yield* TestClock.adjust('3 seconds')
      assert.deepStrictEqual(yield* Fiber.join(stopFiber), {
        status: 'stopped',
      })
    })
  )

  it.effect('fails safely when the daemon does not stop within the bound', () =>
    Effect.gen(function* () {
      const client = yield* clientFor(
        processControlLayer(
          () => Effect.succeed([101]),
          () => Effect.void
        )
      )

      const stopFiber = yield* Effect.forkChild(client['slackDaemon.stop']())
      yield* TestClock.adjust('10 seconds')
      const error = yield* Effect.flip(Fiber.join(stopFiber))
      assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {
        _tag: 'SlackDaemonStopError',
        code: 'SLACK_DAEMON_STOP_FAILED',
        message: 'Unable to stop Slack daemon.',
      })
    })
  )

  it.effect('revalidates each exact PID before signaling', () =>
    Effect.gen(function* () {
      const validations: Array<readonly [number, ProcessQuery, 'SIGTERM']> = []
      let inspectionCount = 0
      const client = yield* clientFor(
        processControlLayer(
          () =>
            Effect.sync(() => {
              inspectionCount += 1
              return inspectionCount === 1 ? [101] : []
            }),
          () => Effect.void,
          (pid, query, signal) =>
            Effect.sync(() => {
              validations.push([pid, query, signal])
              return false
            })
        )
      )

      const stopFiber = yield* Effect.forkChild(client['slackDaemon.stop']())
      yield* TestClock.adjust('100 millis')
      assert.deepStrictEqual(yield* Fiber.join(stopFiber), {
        status: 'stopped',
      })
      assert.deepStrictEqual(validations, [
        [
          101,
          {
            commandPath: SOURCE_SLACK_DAEMON_COMMAND,
            cwd: SOURCE_LABORER_CHECKOUT,
          },
          'SIGTERM',
        ],
      ])
    })
  )

  it('keeps Keychain expansion in the launched shell without credential values', () => {
    const credentialValues = [
      'app-credential-value',
      'steeple-credential-value',
      'freckle-credential-value',
    ]
    const commandText = SOURCE_SLACK_DAEMON_LAUNCH.args.join(' ')

    assert.strictEqual(SOURCE_SLACK_DAEMON_LAUNCH.file, '/bin/zsh')
    assert.strictEqual(SOURCE_SLACK_DAEMON_LAUNCH.cwd, SOURCE_LABORER_CHECKOUT)
    assert.match(
      SOURCE_SLACK_DAEMON_LAUNCH.env.PATH ?? '',
      PINNED_NODE_PATH_PATTERN
    )
    assert.include(
      commandText,
      '/Users/izakfilmalter/.bun/bin/bun run start:bot'
    )
    assert.include(commandText, 'laborer-slack-app-token-steeple')
    assert.include(commandText, 'laborer-slack-bot-token-steeple')
    assert.include(commandText, 'laborer-slack-bot-token-freckle')
    assert.include(commandText, 'T0169RZR7MY')
    assert.include(commandText, 'T04UDJP9283')
    assert.notInclude(commandText, credentialValues.join(' '))
    for (const credential of credentialValues) {
      assert.notInclude(commandText, credential)
      assert.notInclude(
        JSON.stringify(SOURCE_SLACK_DAEMON_LAUNCH.env),
        credential
      )
    }
  })
})

describe('ProcessInspector', () => {
  it.effect('skips a candidate that exits before lsof', () =>
    Effect.gen(function* () {
      const inspector = makeProcessInspector((file) => {
        if (file === 'ps') {
          return Effect.succeed(
            `101 /usr/bin/node ${SOURCE_SLACK_DAEMON_COMMAND}`
          )
        }
        return new ProcessInspectionError({ message: 'candidate exited' })
      })

      assert.deepStrictEqual(
        yield* inspector.matchingPids({
          commandPath: SOURCE_SLACK_DAEMON_COMMAND,
          cwd: SOURCE_LABORER_CHECKOUT,
        }),
        []
      )
    })
  )
})
