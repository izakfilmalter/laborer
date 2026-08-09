import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import type { WebClient } from "@slack/web-api";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  type AcpAuthorityRepository,
  AcpPermissionAuthorityRecord,
  makeAcpAuthorityRepository,
} from "../src/acp-runtime/acp-authority.ts";
import {
  ACP_PERMISSION_ALLOW_ACTION_ID,
  ACP_PERMISSION_REJECT_ACTION_ID,
  type AcpPermissionInteraction,
  type AcpPermissionPresentationRequest,
  type AcpPermissionPresenter,
  type AcpPermissionTurnAuthority,
  makeAcpPermissionBroker,
} from "../src/acp-runtime/acp-permission-broker.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makeSlackAcpPermissionPresenter } from "../src/slack/acp-permission-presenter.ts";
import {
  ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL,
  ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES,
  type AcpPermissionTerminalOutbox,
  AcpPermissionTerminalUpdate,
  makePresentationIntent,
} from "../src/slack/acp-permission-ui-outbox.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const authority: AcpPermissionTurnAuthority = {
  authorizedSlackUserId: "U245AUTHORIZED",
  bindingGeneration: 7,
  channelId: "C245CHANNEL",
  conversationId: "conversation:245",
  processGeneration: 11,
  promptId: "prompt:245",
  rootTs: "245.100",
  sessionId: "session:245",
  turnId: "turn:245",
  workspaceId: "T245WORKSPACE",
};

const permissionRequest = (options?: {
  readonly includeReject?: boolean;
  readonly rawInput?: unknown;
  readonly toolCallId?: string;
}): RequestPermissionRequest => ({
  options: [
    { kind: "allow_once", name: "Allow once", optionId: "opaque-allow-245" },
    { kind: "allow_always", name: "Always", optionId: "opaque-always-245" },
    ...(options?.includeReject === false
      ? []
      : [
          {
            kind: "reject_once" as const,
            name: "Reject",
            optionId: "opaque-reject-245",
          },
        ]),
  ],
  sessionId: authority.sessionId,
  toolCall: {
    kind: "execute",
    rawInput: options?.rawInput ?? { command: "private command" },
    status: "pending",
    title: "private title",
    toolCallId: options?.toolCallId ?? "private-tool-call-245",
  },
});

interface PresentationCapture {
  readonly posted: AcpPermissionPresentationRequest[];
  readonly settled: string[];
}

const makePresenter = (
  capture: PresentationCapture,
  posted: Deferred.Deferred<void>
): AcpPermissionPresenter => ({
  drain: Effect.void,
  post: (request) =>
    Effect.gen(function* () {
      capture.posted.push(request);
      yield* Deferred.succeed(posted, undefined);
      return { messageTs: "245.200" };
    }),
  settle: ({ state }) =>
    Effect.sync(() => {
      capture.settled.push(state);
    }),
});

const interaction = (
  capability: string,
  additions: Partial<AcpPermissionInteraction> = {}
): AcpPermissionInteraction => ({
  actionId: ACP_PERMISSION_ALLOW_ACTION_ID,
  capability,
  channelId: authority.channelId,
  messageTs: "245.200",
  rootTs: authority.rootTs,
  slackUserId: authority.authorizedSlackUserId ?? "",
  workspaceId: authority.workspaceId,
  ...additions,
});

const makeFixture = Effect.fnUntraced(function* (timeoutMillis = 60_000) {
  const root = yield* makeTempDirectoryScoped("laborer-245-authority-");
  const repository = yield* makeAcpAuthorityRepository({
    keyPath: join(root, "authority.key"),
    statePath: join(root, "authority.json"),
    trustedRoot: root,
  });
  const capture: PresentationCapture = { posted: [], settled: [] };
  const posted = yield* Deferred.make<void>();
  const broker = yield* makeAcpPermissionBroker({
    presenter: makePresenter(capture, posted),
    repository,
    timeoutMillis,
  });
  const closeTurn = yield* broker.activateTurn(authority);
  return { broker, capture, closeTurn, posted, repository, root };
});

const makeInMemoryAuthorityRepository = (): {
  readonly repository: AcpAuthorityRepository;
  readonly snapshot: () => readonly AcpPermissionAuthorityRecord[];
} => {
  let capabilitySequence = 0;
  let records: readonly AcpPermissionAuthorityRecord[] = [];
  const digest = (namespace: string, value: string): string =>
    createHash("sha256").update(`${namespace}\0${value}`).digest("base64url");
  return {
    repository: {
      digest,
      load: Effect.sync(() => records),
      makeCapability: () => {
        capabilitySequence += 1;
        const token = `in-memory-capability-${capabilitySequence}`;
        return { digest: digest("permission-capability", token), token };
      },
      transact: (update) =>
        Effect.sync(() => {
          const [value, next] = update(records);
          records = [...next];
          return value;
        }),
    },
    snapshot: () => records,
  };
};

const makeRejectingOutbox = (
  safeDetail: string
): {
  readonly outbox: AcpPermissionTerminalOutbox;
  readonly setEntries: (
    entries: readonly AcpPermissionTerminalUpdate[]
  ) => void;
} => {
  let retained: readonly AcpPermissionTerminalUpdate[] = [];
  return {
    outbox: {
      load: Effect.sync(() => retained),
      remove: () => Effect.die(new Error("rejected presentation was evicted")),
      upsert: () =>
        Effect.fail(
          HandlerFailure.make({
            category: "protocol",
            safeDetail,
          })
        ),
    },
    setEntries: (entries) => {
      retained = entries;
    },
  };
};

const runAdmissionFailureStress = Effect.fnUntraced(function* (options: {
  readonly retained: readonly AcpPermissionTerminalUpdate[];
  readonly safeDetail: string;
}) {
  const authorityState = makeInMemoryAuthorityRepository();
  const rejectingOutbox = makeRejectingOutbox(options.safeDetail);
  let posts = 0;
  const runtimeEntryCounts = [0];
  const livePermissionCounts = [{ capabilities: 0, requestWaiters: 0 }];
  const client = {
    chat: {
      postMessage: () => {
        posts += 1;
        return Promise.resolve({ ts: "must-not-post" });
      },
      update: () => Promise.resolve({ ok: true }),
    },
  } as unknown as WebClient;
  const presenter = makeSlackAcpPermissionPresenter(client, {
    outbox: rejectingOutbox.outbox,
    testHooks: {
      onRuntimeEntryCountChanged: (count) => {
        runtimeEntryCounts.push(count);
      },
    },
    workspaceId: authority.workspaceId,
  });
  const broker = yield* makeAcpPermissionBroker({
    presenter,
    repository: authorityState.repository,
    testHooks: {
      onLivePermissionCountChanged: (counts) => {
        livePermissionCounts.push(counts);
      },
    },
    timeoutMillis: 60_000,
  });
  rejectingOutbox.setEntries(options.retained);
  yield* broker.activateTurn(authority).pipe(Effect.asVoid);
  const rejectedRequestCount =
    ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES + 16;
  const outcomes = yield* Effect.forEach(
    Array.from({ length: rejectedRequestCount }, (_, index) => index),
    (index) =>
      broker.request(
        permissionRequest({
          toolCallId: `admission-rejected-tool-call-${index}`,
        })
      )
  );
  return {
    authorityRecords: authorityState.snapshot(),
    livePermissionCounts,
    outcomes,
    posts,
    retained: yield* rejectingOutbox.outbox.load,
    runtimeEntryCounts,
  };
});

const waitForMessageBinding = Effect.fnUntraced(function* (
  repository: AcpAuthorityRepository
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = yield* repository.load;
    if (records.some((record) => record.messageDigest !== null)) {
      return;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("permission message was not bound"));
});

const waitForPresentationCount = Effect.fnUntraced(function* (
  capture: PresentationCapture,
  expected: number
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (capture.posted.length === expected) {
      return;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );
  }
  return yield* Effect.die(
    new Error(`permission presentation count did not reach ${expected}`)
  );
});

describe("issue #245 durable ACP permission broker", () => {
  it.effect("bounds a noisy agent to four pending requests in one turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const startPermission = (index: number) =>
          fixture.broker
            .request(
              permissionRequest({ toolCallId: `noisy-tool-call-${index}` })
            )
            .pipe(Effect.forkChild);
        const first = yield* startPermission(0);
        yield* waitForPresentationCount(fixture.capture, 1);
        const second = yield* startPermission(1);
        yield* waitForPresentationCount(fixture.capture, 2);
        const third = yield* startPermission(2);
        yield* waitForPresentationCount(fixture.capture, 3);
        const fourth = yield* startPermission(3);
        yield* waitForPresentationCount(fixture.capture, 4);
        const pending = [first, second, third, fourth];
        assert.strictEqual(fixture.capture.posted.length, 4);
        assert.deepStrictEqual(
          yield* fixture.broker.request(
            permissionRequest({ toolCallId: "noisy-tool-call-overflow" })
          ),
          { outcome: { outcome: "cancelled" } }
        );
        assert.strictEqual(fixture.capture.posted.length, 4);
        yield* fixture.closeTurn;
        for (const fiber of pending) {
          assert.deepStrictEqual(yield* Fiber.join(fiber), {
            outcome: { outcome: "cancelled" },
          });
        }
      })
    )
  );

  it.effect(
    "bounds runtime state across many unique requests rejected by a full presentation outbox",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = Date.now();
          const retained = Array.from(
            { length: ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES },
            (_, index) =>
              AcpPermissionTerminalUpdate.make({
                ...makePresentationIntent({
                  authorizedSlackUserId: authority.authorizedSlackUserId ?? "",
                  category: "shell",
                  channelId: authority.channelId,
                  deadlineAt: now + 30_000,
                  permissionExpiresAt: now + 60_000,
                  presentationMarker: `broker-capacity-marker-${index}`,
                  rootTs: authority.rootTs,
                  workspaceId: authority.workspaceId,
                }),
                state: "cancelled",
                status: "posting-ambiguous",
              })
          );
          const observed = yield* runAdmissionFailureStress({
            retained,
            safeDetail: ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL,
          });
          assert.ok(
            observed.outcomes.every(
              (outcome) => outcome.outcome.outcome === "cancelled"
            )
          );
          assert.strictEqual(observed.posts, 0);
          assert.strictEqual(observed.runtimeEntryCounts.at(-1), 0);
          assert.ok(observed.runtimeEntryCounts.every((count) => count <= 1));
          assert.deepStrictEqual(observed.livePermissionCounts.at(-1), {
            capabilities: 0,
            requestWaiters: 0,
          });
          assert.ok(
            observed.livePermissionCounts.every(
              ({ capabilities, requestWaiters }) =>
                capabilities <= 1 && requestWaiters <= 1
            )
          );
          assert.strictEqual(
            observed.retained.length,
            ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES
          );
          assert.deepStrictEqual(
            observed.retained.map(({ id }) => id),
            Array.from(
              { length: ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES },
              (_, index) => `broker-capacity-marker-${index}`
            )
          );
          assert.ok(
            observed.authorityRecords.every(
              (record) => record.state !== "pending"
            )
          );
        })
      )
  );

  it.effect(
    "bounds runtime state across persistent pre-admission outbox I/O failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* runAdmissionFailureStress({
            retained: [],
            safeDetail: "injected persistent outbox I/O failure",
          });
          assert.ok(
            observed.outcomes.every(
              (outcome) => outcome.outcome.outcome === "cancelled"
            )
          );
          assert.strictEqual(observed.posts, 0);
          assert.strictEqual(observed.runtimeEntryCounts.at(-1), 0);
          assert.ok(observed.runtimeEntryCounts.every((count) => count <= 1));
          assert.deepStrictEqual(observed.livePermissionCounts.at(-1), {
            capabilities: 0,
            requestWaiters: 0,
          });
          assert.ok(
            observed.livePermissionCounts.every(
              ({ capabilities, requestWaiters }) =>
                capabilities <= 1 && requestWaiters <= 1
            )
          );
          assert.deepStrictEqual(observed.retained, []);
          assert.ok(
            observed.authorityRecords.every(
              (record) => record.state !== "pending"
            )
          );
        })
      )
  );

  it.effect(
    "selects only the exact allow-once option and settles duplicates once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const first = yield* fixture.broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          const duplicate = yield* fixture.broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(fixture.posted);
          yield* waitForMessageBinding(fixture.repository);
          const capability = fixture.capture.posted[0]?.capability;
          assert.ok(capability !== undefined);
          assert.strictEqual(
            yield* fixture.broker.handleInteraction(interaction(capability)),
            "claimed"
          );
          yield* fixture.broker.handleInteraction(interaction(capability));
          assert.deepStrictEqual(yield* Fiber.join(first), {
            outcome: { optionId: "opaque-allow-245", outcome: "selected" },
          });
          assert.deepStrictEqual(yield* Fiber.join(duplicate), {
            outcome: { optionId: "opaque-allow-245", outcome: "selected" },
          });
          assert.strictEqual(fixture.capture.posted.length, 1);
          assert.ok(
            fixture.capture.posted.every(
              (request) => !JSON.stringify(request).includes("always")
            )
          );
        })
      )
  );

  it.effect(
    "cancels a request whose Slack post finishes after its turn closes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-245-post-race-");
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const postStarted = yield* Deferred.make<void>();
          const releasePost = yield* Deferred.make<void>();
          const capture: PresentationCapture = { posted: [], settled: [] };
          const presenter: AcpPermissionPresenter = {
            drain: Effect.void,
            post: (request) =>
              Effect.gen(function* () {
                capture.posted.push(request);
                yield* Deferred.succeed(postStarted, undefined);
                yield* Deferred.await(releasePost);
                return { messageTs: "245.200" };
              }),
            settle: ({ state }) =>
              Effect.sync(() => {
                capture.settled.push(state);
              }),
          };
          const broker = yield* makeAcpPermissionBroker({
            presenter,
            repository,
          });
          const closeTurn = yield* broker.activateTurn(authority);
          const pending = yield* broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(postStarted);
          yield* closeTurn;
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            outcome: { outcome: "cancelled" },
          });
          assert.deepStrictEqual(capture.settled, ["cancelled"]);
          yield* Deferred.succeed(releasePost, undefined);
          assert.ok(
            (yield* repository.load).every(
              (record) => record.state !== "pending"
            )
          );
        })
      )
  );

  it.effect(
    "retains a click that arrives while its Slack message is being durably bound",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-message-binding-race-"
          );
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const postStarted = yield* Deferred.make<void>();
          const releasePost = yield* Deferred.make<void>();
          const capture: PresentationCapture = { posted: [], settled: [] };
          const presenter: AcpPermissionPresenter = {
            drain: Effect.void,
            post: (request) =>
              Effect.gen(function* () {
                capture.posted.push(request);
                yield* Deferred.succeed(postStarted, undefined);
                yield* Deferred.await(releasePost);
                return { messageTs: "245.200" };
              }),
            settle: ({ state }) =>
              Effect.sync(() => {
                capture.settled.push(state);
              }),
          };
          const broker = yield* makeAcpPermissionBroker({
            presenter,
            repository,
          });
          const closeTurn = yield* broker.activateTurn(authority);
          const pending = yield* broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(postStarted);
          const capability = capture.posted[0]?.capability;
          assert.ok(capability !== undefined);
          const click = yield* broker
            .handleInteraction(interaction(capability))
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releasePost, undefined);
          yield* Fiber.join(click);
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            outcome: { optionId: "opaque-allow-245", outcome: "selected" },
          });
          yield* closeTurn;
        })
      )
  );

  it.effect(
    "recovers an exact decision whose durable publish reported uncertainty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let records: readonly AcpPermissionAuthorityRecord[] = [];
          let failAfterNextTransaction = false;
          const uncertainRepository: AcpAuthorityRepository = {
            digest: (namespace, value) =>
              createHash("sha256")
                .update(`${namespace}\0${value}`)
                .digest("base64url"),
            load: Effect.sync(() => records),
            makeCapability: () => ({
              digest: "fixture-capability-digest",
              token: "fixture-capability-token",
            }),
            transact: (update) =>
              Effect.suspend(() => {
                const [value, updated] = update(records);
                records = updated;
                if (failAfterNextTransaction && value === "claimed") {
                  failAfterNextTransaction = false;
                  return Effect.die(
                    new Error("fixture post-publish uncertainty")
                  );
                }
                return Effect.succeed(value);
              }),
          };
          const capture: PresentationCapture = { posted: [], settled: [] };
          const posted = yield* Deferred.make<void>();
          const broker = yield* makeAcpPermissionBroker({
            presenter: makePresenter(capture, posted),
            repository: uncertainRepository,
          });
          const closeTurn = yield* broker.activateTurn(authority);
          const pending = yield* broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(posted);
          yield* waitForMessageBinding(uncertainRepository);
          const capability = capture.posted[0]?.capability;
          assert.ok(capability !== undefined);
          failAfterNextTransaction = true;
          assert.strictEqual(
            yield* broker.handleInteraction(interaction(capability)),
            "claimed"
          );
          assert.strictEqual(
            yield* broker.handleInteraction(interaction(capability)),
            "ignored"
          );
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            outcome: { optionId: "opaque-allow-245", outcome: "selected" },
          });
          yield* closeTurn;
        })
      )
  );

  it.effect(
    "reconciles a decision after authority rename succeeds but directory sync reports uncertainty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-authority-post-rename-"
          );
          let failAfterRename = false;
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            testHooks: {
              afterStateRename: () => {
                if (!failAfterRename) {
                  return Promise.resolve();
                }
                failAfterRename = false;
                return Promise.reject(
                  new Error("fixture directory sync uncertainty")
                );
              },
            },
            trustedRoot: root,
          });
          const capture: PresentationCapture = { posted: [], settled: [] };
          const posted = yield* Deferred.make<void>();
          const broker = yield* makeAcpPermissionBroker({
            presenter: makePresenter(capture, posted),
            repository,
          });
          const closeTurn = yield* broker.activateTurn(authority);
          const pending = yield* broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(posted);
          yield* waitForMessageBinding(repository);
          const capability = capture.posted[0]?.capability;
          assert.ok(capability !== undefined);
          // The repository shows the message binding as soon as its rename
          // lands, but the binding transact is still inside the broker's
          // serialized gate section until it signals message readiness.
          // Arming the rename failure in that window would hand the one-shot
          // failure to the binding transact instead of the claim, killing the
          // binding fiber before readiness and hanging the claim forever. A
          // gated interaction for an unknown capability cannot start until
          // the binding section finishes, so its completion proves the
          // one-shot failure can only be consumed by the claim below.
          assert.strictEqual(
            yield* broker.handleInteraction(
              interaction("unknown-capability-245")
            ),
            "ignored"
          );
          failAfterRename = true;
          assert.strictEqual(
            yield* broker.handleInteraction(interaction(capability)),
            "claimed"
          );
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            outcome: { optionId: "opaque-allow-245", outcome: "selected" },
          });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (capture.settled.length === 1) {
              break;
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setImmediate(resolve))
            );
          }
          assert.deepStrictEqual(capture.settled, ["allowed"]);
          yield* closeTurn;
        })
      ),
    30_000
  );

  it.effect(
    "keeps one shared live completion after terminal publication for allow and reject retries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const decision of [
            {
              actionId: ACP_PERMISSION_ALLOW_ACTION_ID,
              optionId: "opaque-allow-245",
              state: "allowed",
            },
            {
              actionId: ACP_PERMISSION_REJECT_ACTION_ID,
              optionId: "opaque-reject-245",
              state: "rejected",
            },
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-245-shared-completion-${decision.state}-`
            );
            const repository = yield* makeAcpAuthorityRepository({
              keyPath: join(root, "authority.key"),
              statePath: join(root, "authority.json"),
              trustedRoot: root,
            });
            const capture: PresentationCapture = { posted: [], settled: [] };
            const posted = yield* Deferred.make<void>();
            const terminalPublished = yield* Deferred.make<void>();
            const releaseCompletion = yield* Deferred.make<void>();
            const broker = yield* makeAcpPermissionBroker({
              presenter: makePresenter(capture, posted),
              repository,
              testHooks: {
                afterTerminalPublishBeforeLiveCompletion: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(terminalPublished, undefined);
                    yield* Deferred.await(releaseCompletion);
                  }),
              },
            });
            const closeTurn = yield* broker.activateTurn(authority);
            const pending = yield* broker
              .request(permissionRequest())
              .pipe(Effect.forkChild);
            yield* Deferred.await(posted);
            yield* waitForMessageBinding(repository);
            const capability = capture.posted[0]?.capability;
            assert.ok(capability !== undefined);
            const exactInteraction = interaction(capability, {
              actionId: decision.actionId,
            });
            const claimed = yield* broker
              .handleInteraction(exactInteraction)
              .pipe(Effect.forkChild);
            yield* Deferred.await(terminalPublished);
            assert.strictEqual(yield* Fiber.join(claimed), "claimed");
            assert.strictEqual(
              yield* broker.handleInteraction(exactInteraction),
              "claimed"
            );
            assert.strictEqual(capture.settled.length, 0);
            yield* Deferred.succeed(releaseCompletion, undefined);
            assert.deepStrictEqual(yield* Fiber.join(pending), {
              outcome: { optionId: decision.optionId, outcome: "selected" },
            });
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (capture.settled.length === 1) {
                break;
              }
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setImmediate(resolve))
              );
            }
            assert.deepStrictEqual(capture.settled, [decision.state]);
            assert.strictEqual(
              yield* broker.handleInteraction(exactInteraction),
              "ignored"
            );
            yield* closeTurn;
          }
        })
      )
  );

  it.effect("returns the exact reject-once option", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const pending = yield* fixture.broker
          .request(permissionRequest())
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.posted);
        yield* waitForMessageBinding(fixture.repository);
        const capability = fixture.capture.posted[0]?.capability;
        assert.ok(capability !== undefined);
        yield* fixture.broker.handleInteraction(
          interaction(capability, {
            actionId: ACP_PERMISSION_REJECT_ACTION_ID,
          })
        );
        assert.deepStrictEqual(yield* Fiber.join(pending), {
          outcome: { optionId: "opaque-reject-245", outcome: "selected" },
        });
      })
    )
  );

  it.effect("cancels when a one-shot option is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        assert.deepStrictEqual(
          yield* fixture.broker.request(
            permissionRequest({ includeReject: false })
          ),
          { outcome: { outcome: "cancelled" } }
        );
        assert.deepStrictEqual(fixture.capture.posted, []);
      })
    )
  );

  it.effect("cancels bot-only turns without creating an interaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.closeTurn;
        const closeBotTurn = yield* fixture.broker.activateTurn({
          ...authority,
          authorizedSlackUserId: null,
          promptId: "bot-only-prompt",
          turnId: "bot-only-turn",
        });
        assert.deepStrictEqual(
          yield* fixture.broker.request(permissionRequest()),
          { outcome: { outcome: "cancelled" } }
        );
        assert.deepStrictEqual(fixture.capture.posted, []);
        yield* closeBotTurn;
      })
    )
  );

  it.effect("cancels at the deadline under TestClock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(1000);
        const pending = yield* fixture.broker
          .request(permissionRequest())
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.posted);
        yield* waitForMessageBinding(fixture.repository);
        yield* Effect.forEach(
          Array.from({ length: 10 }),
          () => Effect.yieldNow,
          { discard: true }
        );
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(pending), {
          outcome: { outcome: "cancelled" },
        });
      })
    )
  );

  it.effect(
    "cancels at the deadline when Slack presentation never settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-presentation-timeout-"
          );
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const postStarted = yield* Deferred.make<void>();
          const presenter: AcpPermissionPresenter = {
            drain: Effect.void,
            post: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(postStarted, undefined);
                return yield* Effect.never;
              }),
            settle: () => Effect.void,
          };
          const broker = yield* makeAcpPermissionBroker({
            presenter,
            repository,
            timeoutMillis: 1000,
          });
          yield* broker.activateTurn(authority).pipe(Effect.asVoid);
          const pending = yield* broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(postStarted);
          yield* TestClock.adjust("1 second");
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            outcome: { outcome: "cancelled" },
          });
          assert.ok(
            (yield* repository.load).every(
              (record) => record.state !== "pending"
            )
          );
        })
      )
  );

  it.effect("rejects stale and cross-scope clicks without disclosure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const pending = yield* fixture.broker
          .request(permissionRequest())
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.posted);
        yield* waitForMessageBinding(fixture.repository);
        const capability = fixture.capture.posted[0]?.capability;
        assert.ok(capability !== undefined);
        for (const invalid of [
          { slackUserId: "U245OTHER" },
          { channelId: "C245OTHER" },
          { rootTs: "245.999" },
          { messageTs: "245.999" },
          { workspaceId: "T245OTHER" },
          { capability: "stale-capability" },
        ]) {
          yield* fixture.broker.handleInteraction(
            interaction(capability, invalid)
          );
        }
        yield* fixture.closeTurn;
        assert.deepStrictEqual(yield* Fiber.join(pending), {
          outcome: { outcome: "cancelled" },
        });
      })
    )
  );

  it.effect("cancels pending ACP requests when the broker is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const pending = yield* fixture.broker
          .request(permissionRequest())
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.posted);
        yield* waitForMessageBinding(fixture.repository);
        yield* fixture.broker.cancelAll;
        assert.deepStrictEqual(yield* Fiber.join(pending), {
          outcome: { outcome: "cancelled" },
        });
        assert.ok(
          (yield* fixture.repository.load).every(
            (record) => record.state !== "pending"
          )
        );
      })
    )
  );

  it.effect(
    "fails conflicting reuse closed and persists no raw private data",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const privateValue =
            "https://user:secret@example.test/path?token=private-value";
          const first = yield* fixture.broker
            .request(permissionRequest({ rawInput: { url: privateValue } }))
            .pipe(Effect.forkChild);
          yield* Deferred.await(fixture.posted);
          yield* waitForMessageBinding(fixture.repository);
          assert.deepStrictEqual(
            yield* fixture.broker.request(
              permissionRequest({
                rawInput: { url: "different-private-value" },
              })
            ),
            { outcome: { outcome: "cancelled" } }
          );
          assert.deepStrictEqual(yield* Fiber.join(first), {
            outcome: { outcome: "cancelled" },
          });
          const state = yield* Effect.promise(() =>
            readFile(join(fixture.root, "authority.json"), "utf8")
          );
          for (const forbidden of [
            privateValue,
            "private title",
            "private-tool-call-245",
            authority.sessionId,
            authority.authorizedSlackUserId ?? "",
            fixture.capture.posted[0]?.capability ?? "",
          ]) {
            assert.ok(!state.includes(forbidden));
          }
        })
      )
  );

  it.effect(
    "startup sweep cancels records that lost their exact live request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const pending = yield* fixture.broker
            .request(permissionRequest())
            .pipe(Effect.forkChild);
          yield* Deferred.await(fixture.posted);
          yield* waitForMessageBinding(fixture.repository);
          yield* Fiber.interrupt(pending);
          yield* fixture.repository.transact((records) => [
            undefined,
            records.map((record) =>
              AcpPermissionAuthorityRecord.make({
                ...record,
                state: "pending",
              })
            ),
          ]);
          const restartedPosted = yield* Deferred.make<void>();
          yield* makeAcpPermissionBroker({
            presenter: makePresenter(fixture.capture, restartedPosted),
            repository: fixture.repository,
          });
          const records = yield* fixture.repository.load;
          assert.ok(records.every((record) => record.state === "cancelled"));
        })
      )
  );
});
