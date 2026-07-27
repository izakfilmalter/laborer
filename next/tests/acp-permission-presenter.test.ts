import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { WebClient } from "@slack/web-api";
import { Effect, Exit, Fiber } from "effect";
import { HandlerFailure } from "../src/prototype/errors.ts";
import {
  acpPermissionFallbackText,
  makeSlackAcpPermissionPresenter,
} from "../src/slack/acp-permission-presenter.ts";
import {
  ACP_PERMISSION_UI_DIAGNOSTIC_RETENTION_MILLIS,
  ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES,
  type AcpPermissionTerminalOutbox,
  AcpPermissionTerminalUpdate,
  makeAcpPermissionTerminalOutbox,
  makePresentationIntent,
} from "../src/slack/acp-permission-ui-outbox.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const presentationRequest = {
  authorizedSlackUserId: "U245ACTOR",
  capability: "opaque-capability-245",
  category: "shell" as const,
  channelId: "C245CHANNEL",
  expiresAt: Date.now() + 5 * 60 * 1000,
  presentationMarker: "presentation-marker-245",
  rootTs: "245.100",
  workspaceId: "T245WORKSPACE",
};

const makeDelayedClient = () => {
  let resolvePost: ((value: { readonly ts: string }) => void) | undefined;
  const post = new Promise<{ readonly ts: string }>((resolve) => {
    resolvePost = resolve;
  });
  const updates: unknown[] = [];
  const client = {
    chat: {
      postMessage: () => post,
      update: (request: unknown) => {
        updates.push(request);
        return Promise.resolve({ ok: true });
      },
    },
  } as unknown as WebClient;
  return {
    client,
    resolvePost: (messageTs: string): void => resolvePost?.({ ts: messageTs }),
    updates,
  };
};

const waitForUpdate = Effect.fnUntraced(function* (
  updates: readonly unknown[]
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (updates.length > 0) {
      return;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );
  }
  return yield* Effect.die(
    new Error("late Slack permission update was absent")
  );
});

const waitUntil = Effect.fnUntraced(function* (
  predicate: () => boolean,
  message: string
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) {
      return;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );
  }
  return yield* Effect.die(new Error(message));
});

const waitForEmptyOutbox = Effect.fnUntraced(function* (
  outbox: AcpPermissionTerminalOutbox
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if ((yield* outbox.load).length === 0) {
      return;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );
  }
  return yield* Effect.die(new Error("permission UI outbox did not drain"));
});

const waitForOutboxEntries = Effect.fnUntraced(function* (
  outbox: AcpPermissionTerminalOutbox,
  predicate: (entries: readonly AcpPermissionTerminalUpdate[]) => boolean
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const entries = yield* outbox.load;
    if (predicate(entries)) {
      return entries;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );
  }
  return yield* Effect.die(
    new Error("permission UI outbox did not reach its expected state")
  );
});

describe("issue #245 Slack ACP permission presentation", () => {
  it("provides bounded accessible fallback text without sensitive details", () => {
    const text = acpPermissionFallbackText(presentationRequest);
    assert.ok(text.includes("<@U245ACTOR>"));
    assert.ok(text.includes("one shell operation"));
    assert.ok(text.includes("Arguments are hidden"));
    assert.ok(text.includes("Allow once"));
    assert.ok(text.includes("Reject"));
    assert.ok(text.length <= 300);
    assert.ok(!text.includes("opaque-capability-245"));
  });

  it.effect(
    "removes provisional entries after every classified pre-admission failure",
    () =>
      Effect.gen(function* () {
        const failures = [
          {
            publishBeforeFailure: false,
            safeDetail: "injected file I/O failure",
          },
          {
            publishBeforeFailure: false,
            safeDetail: "injected decode corruption",
          },
          { publishBeforeFailure: false, safeDetail: "injected lock timeout" },
          {
            publishBeforeFailure: true,
            safeDetail: "injected post-publication uncertainty",
          },
        ];
        for (const [index, failure] of failures.entries()) {
          let posts = 0;
          const durablyVisible: AcpPermissionTerminalUpdate[] = [];
          const runtimeEntryCounts = [0];
          const outbox: AcpPermissionTerminalOutbox = {
            load: Effect.sync(() => durablyVisible),
            remove: () => Effect.void,
            upsert: (entry) =>
              Effect.gen(function* () {
                if (failure.publishBeforeFailure) {
                  durablyVisible.push(entry);
                }
                return yield* HandlerFailure.make({
                  category: "protocol",
                  safeDetail: failure.safeDetail,
                });
              }),
          };
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
            outbox,
            testHooks: {
              onRuntimeEntryCountChanged: (count) => {
                runtimeEntryCounts.push(count);
              },
            },
          });
          const result = yield* Effect.exit(
            presenter.post({
              ...presentationRequest,
              capability: `pre-admission-failure-capability-${index}`,
              presentationMarker: `pre-admission-failure-marker-${index}`,
            })
          );
          assert.ok(Exit.isFailure(result));
          assert.strictEqual(posts, 0);
          assert.deepStrictEqual(runtimeEntryCounts, [0, 1, 0]);
          assert.strictEqual(
            durablyVisible.length,
            failure.publishBeforeFailure ? 1 : 0
          );
        }
      })
  );

  it.effect("removes a provisional entry when admission is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let posts = 0;
        const runtimeEntryCounts = [0];
        const outbox: AcpPermissionTerminalOutbox = {
          load: Effect.succeed([]),
          remove: () => Effect.void,
          upsert: () => Effect.never,
        };
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
          outbox,
          testHooks: {
            onRuntimeEntryCountChanged: (count) => {
              runtimeEntryCounts.push(count);
            },
          },
        });
        const posting = yield* presenter
          .post({
            ...presentationRequest,
            capability: "interrupted-admission-capability",
            presentationMarker: "interrupted-admission-marker",
          })
          .pipe(Effect.forkChild);
        yield* waitUntil(
          () => runtimeEntryCounts.at(-1) === 1,
          "provisional presentation entry was not created"
        );
        yield* Fiber.interrupt(posting);
        yield* waitUntil(
          () => runtimeEntryCounts.at(-1) === 0,
          "interrupted provisional presentation entry was retained"
        );
        assert.strictEqual(posts, 0);
        assert.deepStrictEqual(runtimeEntryCounts, [0, 1, 0]);
      })
    )
  );

  it.effect(
    "retains an entry after durable admission until broker settlement",
    () =>
      Effect.gen(function* () {
        const runtimeEntryCounts = [0];
        const outbox: AcpPermissionTerminalOutbox = {
          load: Effect.succeed([]),
          remove: () => Effect.void,
          upsert: () => Effect.void,
        };
        const client = {
          chat: {
            postMessage: () => Promise.reject({ data: { error: "fatal" } }),
            update: () => Promise.resolve({ ok: true }),
          },
        } as unknown as WebClient;
        const presenter = makeSlackAcpPermissionPresenter(client, {
          outbox,
          testHooks: {
            onRuntimeEntryCountChanged: (count) => {
              runtimeEntryCounts.push(count);
            },
          },
        });
        const result = yield* Effect.exit(presenter.post(presentationRequest));
        assert.ok(Exit.isFailure(result));
        assert.strictEqual(runtimeEntryCounts.at(-1), 1);
        yield* presenter.settle({
          ...presentationRequest,
          messageTs: null,
          state: "cancelled",
        });
        assert.strictEqual(runtimeEntryCounts.at(-1), 0);
      })
  );

  it.effect(
    "migrates a premature version-two marker failure back to unresolved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-outbox-v2-"
          );
          const path = join(root, "outbox.json");
          const now = Date.now();
          yield* Effect.promise(() =>
            writeFile(
              path,
              JSON.stringify({
                entries: [
                  {
                    attempts: 5,
                    authorizedSlackUserId:
                      presentationRequest.authorizedSlackUserId,
                    category: presentationRequest.category,
                    channelId: presentationRequest.channelId,
                    createdAt: now - 60_000,
                    deadlineAt: now - 30_000,
                    diagnostic: "permission-message-not-found",
                    id: "legacy-v2-marker",
                    messageTs: null,
                    nextAttemptAt: now - 30_000,
                    presentationMarker: "legacy-v2-marker",
                    rootTs: presentationRequest.rootTs,
                    state: "cancelled",
                    status: "permanent-failure",
                    workspaceId: presentationRequest.workspaceId,
                  },
                ],
                schemaVersion: 2,
              }),
              { mode: 0o600 }
            )
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path,
            trustedRoot: root,
          });
          const migrated = yield* outbox.load;
          assert.strictEqual(migrated[0]?.status, "posting-ambiguous");
          assert.strictEqual(migrated[0]?.diagnostic, null);
          assert.ok((migrated[0]?.reconciliationExpiresAt ?? 0) > now);
        })
      )
  );

  it.effect(
    "removes buttons when an uncancellable post resolves after expiry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const delayed = makeDelayedClient();
          const presenter = makeSlackAcpPermissionPresenter(delayed.client);
          const posting = yield* presenter
            .post(presentationRequest)
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* presenter.settle({
            ...presentationRequest,
            messageTs: null,
            state: "expired",
          });
          yield* Fiber.interrupt(posting);
          delayed.resolvePost("245.200");
          yield* waitForUpdate(delayed.updates);
          assert.ok(JSON.stringify(delayed.updates).includes("expired"));
          assert.ok(!JSON.stringify(delayed.updates).includes("Allow once"));
        })
      )
  );

  it.effect("drains a late cancellation update during bounded shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delayed = makeDelayedClient();
        const presenter = makeSlackAcpPermissionPresenter(delayed.client);
        const posting = yield* presenter
          .post(presentationRequest)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* presenter.settle({
          ...presentationRequest,
          messageTs: null,
          state: "cancelled",
        });
        const draining = yield* presenter.drain.pipe(Effect.forkChild);
        delayed.resolvePost("245.201");
        yield* Fiber.join(draining);
        yield* waitForUpdate(delayed.updates);
        assert.ok(JSON.stringify(delayed.updates).includes("cancelled"));
        yield* Fiber.interrupt(posting);
      })
    )
  );

  it.live(
    "retries rate-limit and network failures until terminal controls are removed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-outbox-retry-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          let attempts = 0;
          const client = {
            chat: {
              postMessage: () => Promise.resolve({ ts: "245.300" }),
              update: () => {
                attempts += 1;
                if (attempts === 1) {
                  return Promise.reject({
                    code: "slack_webapi_rate_limited_error",
                    retryAfter: 0.001,
                  });
                }
                if (attempts === 2) {
                  return Promise.reject({ code: "ECONNRESET" });
                }
                return Promise.resolve({ ok: true });
              },
            },
          } as unknown as WebClient;
          const presenter = makeSlackAcpPermissionPresenter(client, {
            outbox,
            retry: { initialBackoffMillis: 1, maxBackoffMillis: 2 },
          });
          const posted = yield* presenter.post(presentationRequest);
          yield* presenter.settle({
            ...presentationRequest,
            messageTs: posted.messageTs,
            state: "allowed",
          });
          yield* waitUntil(
            () => attempts === 3,
            "terminal Slack update was not retried"
          );
          yield* waitForEmptyOutbox(outbox);
        })
      )
  );

  it.live(
    "persists permanent failure and resumes a pending retry after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-outbox-restart-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          const permanentClient = {
            chat: {
              postMessage: () => Promise.resolve({ ts: "245.301" }),
              update: () =>
                Promise.reject({ data: { error: "channel_not_found" } }),
            },
          } as unknown as WebClient;
          const permanent = makeSlackAcpPermissionPresenter(permanentClient, {
            outbox,
          });
          const posted = yield* permanent.post(presentationRequest);
          yield* permanent.settle({
            ...presentationRequest,
            messageTs: posted.messageTs,
            state: "rejected",
          });
          const failed = yield* waitForOutboxEntries(outbox, (entries) =>
            entries.some(({ status }) => status === "permanent-failure")
          );
          assert.strictEqual(failed[0]?.status, "permanent-failure");
          assert.strictEqual(
            failed[0]?.diagnostic,
            "permanent-slack-update-failure"
          );

          const retryEntry = failed[0];
          assert.ok(retryEntry !== undefined);
          yield* outbox.upsert(
            AcpPermissionTerminalUpdate.make({
              ...retryEntry,
              attempts: 0,
              diagnostic: null,
              nextAttemptAt: Date.now(),
              status: "pending",
            })
          );
          let recoveredUpdates = 0;
          const recoveredClient = {
            chat: {
              postMessage: () => Promise.resolve({ ts: "unused" }),
              update: () => {
                recoveredUpdates += 1;
                return Promise.resolve({ ok: true });
              },
            },
          } as unknown as WebClient;
          const recovered = makeSlackAcpPermissionPresenter(recoveredClient, {
            outbox,
          });
          yield* recovered.recover?.(() => Effect.succeed("rejected")) ??
            Effect.void;
          yield* waitUntil(
            () => recoveredUpdates === 1,
            "restart did not recover terminal UI intent"
          );
          yield* waitForEmptyOutbox(outbox);
        })
      )
  );

  it.live(
    "discovers and closes an ambiguous permission post after the original presenter is gone",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-ambiguous-restart-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          let postStarted = false;
          let postedPayload: unknown;
          const originalClient = {
            chat: {
              postMessage: (request: unknown) => {
                postedPayload = request;
                postStarted = true;
                return new Promise<never>(() => undefined);
              },
              update: () => Promise.resolve({ ok: true }),
            },
          } as unknown as WebClient;
          const original = makeSlackAcpPermissionPresenter(originalClient, {
            outbox,
            workspaceId: presentationRequest.workspaceId,
          });
          const posting = yield* original
            .post(presentationRequest)
            .pipe(Effect.forkChild);
          yield* waitUntil(() => postStarted, "permission post did not start");
          assert.ok(
            JSON.stringify(postedPayload).includes(
              presentationRequest.presentationMarker
            )
          );
          const metadata = (postedPayload as { readonly metadata?: unknown })
            .metadata;
          assert.ok(
            !JSON.stringify(metadata).includes(presentationRequest.capability)
          );
          assert.strictEqual((yield* outbox.load)[0]?.status, "posting");
          yield* original.settle({
            ...presentationRequest,
            messageTs: null,
            state: "cancelled",
          });
          assert.strictEqual(
            (yield* outbox.load)[0]?.status,
            "posting-ambiguous"
          );
          assert.ok(
            !JSON.stringify(yield* outbox.load).includes(
              presentationRequest.capability
            )
          );
          yield* Fiber.interrupt(posting);

          const updates: unknown[] = [];
          const restartedClient = {
            chat: {
              postMessage: () => Promise.reject(new Error("not used")),
              update: (request: unknown) => {
                updates.push(request);
                return Promise.resolve({ ok: true });
              },
            },
            conversations: {
              replies: () =>
                Promise.resolve({
                  messages: [
                    {
                      metadata: {
                        event_payload: {
                          presentation_marker:
                            presentationRequest.presentationMarker,
                        },
                        event_type: "laborer_permission_presentation_v1",
                      },
                      thread_ts: presentationRequest.rootTs,
                      ts: "245.400",
                      user: "U245LABORER",
                    },
                  ],
                  ok: true,
                }),
            },
          } as unknown as WebClient;
          const restarted = makeSlackAcpPermissionPresenter(restartedClient, {
            botUserId: "U245LABORER",
            outbox,
            retry: { initialBackoffMillis: 1, maxBackoffMillis: 1 },
            workspaceId: presentationRequest.workspaceId,
          });
          yield* restarted.recover?.(() => Effect.succeed("cancelled")) ??
            Effect.void;
          yield* waitForUpdate(updates);
          assert.ok(JSON.stringify(updates).includes("cancelled"));
          yield* waitForEmptyOutbox(outbox);
        })
      )
  );

  it.live(
    "reconciles an exact marker after a restart delayed by multiple days",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-delayed-restart-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          const now = Date.now();
          const threeDaysMillis = 3 * 24 * 60 * 60 * 1000;
          const createdAt = now - threeDaysMillis;
          const permissionExpiresAt = createdAt + 5 * 60 * 1000;
          yield* outbox.upsert(
            AcpPermissionTerminalUpdate.make({
              ...makePresentationIntent({
                authorizedSlackUserId:
                  presentationRequest.authorizedSlackUserId,
                category: presentationRequest.category,
                channelId: presentationRequest.channelId,
                deadlineAt: createdAt + 30_000,
                permissionExpiresAt,
                presentationMarker: "three-day-old-marker",
                rootTs: presentationRequest.rootTs,
                workspaceId: presentationRequest.workspaceId,
              }),
              createdAt,
              deadlineAt: createdAt + 30_000,
              nextAttemptAt: createdAt + 30_000,
              state: "cancelled",
              status: "posting-ambiguous",
            })
          );
          let lookups = 0;
          const updates: unknown[] = [];
          const client = {
            chat: {
              postMessage: () => Promise.reject(new Error("not used")),
              update: (request: unknown) => {
                updates.push(request);
                return Promise.resolve({ ok: true });
              },
            },
            conversations: {
              replies: () => {
                lookups += 1;
                return Promise.resolve({
                  messages: [
                    {
                      metadata: {
                        event_payload: {
                          presentation_marker: "three-day-old-marker",
                        },
                        event_type: "laborer_permission_presentation_v1",
                      },
                      thread_ts: presentationRequest.rootTs,
                      ts: "245.450",
                      user: "U245LABORER",
                    },
                  ],
                  ok: true,
                });
              },
            },
          } as unknown as WebClient;
          const restarted = makeSlackAcpPermissionPresenter(client, {
            botUserId: "U245LABORER",
            outbox,
            retry: { attempts: 1, deadlineMillis: 1000 },
            workspaceId: presentationRequest.workspaceId,
          });
          yield* restarted.recover?.(() => Effect.succeed("cancelled")) ??
            Effect.void;
          yield* waitForUpdate(updates);
          assert.strictEqual(lookups, 1);
          yield* waitForEmptyOutbox(outbox);
        })
      )
  );

  it.live(
    "records and retains an explicit diagnostic after reconciliation retention expires",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-retention-expiry-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          const now = Date.now();
          const expired = AcpPermissionTerminalUpdate.make({
            ...makePresentationIntent({
              authorizedSlackUserId: presentationRequest.authorizedSlackUserId,
              category: presentationRequest.category,
              channelId: presentationRequest.channelId,
              deadlineAt: now - 1000,
              permissionExpiresAt:
                now - ACP_PERMISSION_UI_DIAGNOSTIC_RETENTION_MILLIS - 1000,
              presentationMarker: "retention-expired-marker",
              rootTs: presentationRequest.rootTs,
              workspaceId: presentationRequest.workspaceId,
            }),
            state: "cancelled",
            status: "posting-ambiguous",
          });
          yield* outbox.upsert(expired);
          let lookups = 0;
          let authorityResolutions = 0;
          const client = {
            chat: {
              postMessage: () => Promise.reject(new Error("not used")),
              update: () => Promise.reject(new Error("not used")),
            },
            conversations: {
              replies: () => {
                lookups += 1;
                return Promise.resolve({ messages: [], ok: true });
              },
            },
          } as unknown as WebClient;
          const restarted = makeSlackAcpPermissionPresenter(client, {
            outbox,
            workspaceId: presentationRequest.workspaceId,
          });
          yield* restarted.recover?.(() => {
            authorityResolutions += 1;
            return Effect.succeed("cancelled");
          }) ?? Effect.void;
          const diagnosed = yield* outbox.load;
          assert.strictEqual(diagnosed.length, 1);
          assert.strictEqual(diagnosed[0]?.status, "permanent-failure");
          assert.strictEqual(
            diagnosed[0]?.diagnostic,
            "reconciliation-retention-expired"
          );
          assert.ok((diagnosed[0]?.retentionExpiresAt ?? 0) > now);
          assert.strictEqual(lookups, 0);
          assert.strictEqual(authorityResolutions, 0);

          const retainedDiagnostic = diagnosed[0];
          assert.ok(retainedDiagnostic !== undefined);
          yield* outbox.upsert(
            AcpPermissionTerminalUpdate.make({
              ...retainedDiagnostic,
              retentionExpiresAt: Date.now() - 1,
            })
          );
          const afterDiagnosticRetention = makeSlackAcpPermissionPresenter(
            client,
            { outbox, workspaceId: presentationRequest.workspaceId }
          );
          yield* afterDiagnosticRetention.recover?.(() =>
            Effect.succeed("cancelled")
          ) ?? Effect.void;
          yield* waitForEmptyOutbox(outbox);
        })
      )
  );

  it.live(
    "preserves 64 unresolved markers, refuses the 65th post, and admits work after cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-outbox-capacity-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          const now = Date.now();
          const markers = Array.from(
            { length: ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES },
            (_, index) => `noisy-agent-marker-${index}`
          );
          for (const [index, marker] of markers.entries()) {
            yield* outbox.upsert(
              AcpPermissionTerminalUpdate.make({
                ...makePresentationIntent({
                  authorizedSlackUserId:
                    presentationRequest.authorizedSlackUserId,
                  category: presentationRequest.category,
                  channelId: presentationRequest.channelId,
                  deadlineAt: now + 5 * 60 * 1000,
                  permissionExpiresAt: now + 5 * 60 * 1000,
                  presentationMarker: marker,
                  rootTs: presentationRequest.rootTs,
                  workspaceId: presentationRequest.workspaceId,
                }),
                messageTs: index === 0 ? "245.500" : null,
                state: index === 0 ? "cancelled" : null,
                status: index === 0 ? "pending" : "posting-ambiguous",
              })
            );
          }
          let posts = 0;
          let updates = 0;
          const client = {
            chat: {
              postMessage: () => {
                posts += 1;
                return Promise.resolve({ ts: "245.501" });
              },
              update: () => {
                updates += 1;
                return Promise.resolve({ ok: true });
              },
            },
            conversations: {
              replies: () => Promise.resolve({ messages: [], ok: true }),
            },
          } as unknown as WebClient;
          const presenter = makeSlackAcpPermissionPresenter(client, {
            botUserId: "U245LABORER",
            outbox,
            retry: { attempts: 1, deadlineMillis: 1000 },
            workspaceId: presentationRequest.workspaceId,
          });
          const refused = yield* Effect.exit(
            presenter.post({
              ...presentationRequest,
              capability: "capacity-refused-capability",
              expiresAt: now + 5 * 60 * 1000,
              presentationMarker: "capacity-refused-marker",
            })
          );
          assert.ok(Exit.isFailure(refused));
          assert.strictEqual(posts, 0);
          const stillRetained = yield* outbox.load;
          assert.strictEqual(
            stillRetained.length,
            ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES
          );
          assert.deepStrictEqual(
            stillRetained.map(({ id }) => id),
            markers
          );

          yield* presenter.recover?.((marker) =>
            Effect.succeed(
              marker === markers[0] ? ("cancelled" as const) : null
            )
          ) ?? Effect.void;
          yield* presenter.drain;
          yield* waitForOutboxEntries(
            outbox,
            (entries) => entries.length === markers.length - 1
          );
          assert.strictEqual(updates, 1);
          const admitted = yield* presenter.post({
            ...presentationRequest,
            capability: "capacity-admitted-capability",
            expiresAt: now + 5 * 60 * 1000,
            presentationMarker: "capacity-admitted-marker",
          });
          assert.strictEqual(admitted.messageTs, "245.501");
          assert.strictEqual(posts, 1);
        })
      ),
    30_000
  );

  it.live(
    "retains missing markers while diagnosing duplicate and wrong-workspace markers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-permission-marker-defense-"
          );
          const outbox = yield* makeAcpPermissionTerminalOutbox({
            path: join(root, "outbox.json"),
            trustedRoot: root,
          });
          const makeAmbiguous = (
            marker: string,
            channelId: string,
            workspaceId = presentationRequest.workspaceId
          ) =>
            AcpPermissionTerminalUpdate.make({
              ...makePresentationIntent({
                authorizedSlackUserId:
                  presentationRequest.authorizedSlackUserId,
                category: presentationRequest.category,
                channelId,
                deadlineAt: Date.now() + 1000,
                permissionExpiresAt: Date.now() + 5 * 60 * 1000,
                presentationMarker: marker,
                rootTs: presentationRequest.rootTs,
                workspaceId,
              }),
              state: "cancelled",
              status: "posting-ambiguous",
            });
          yield* outbox.upsert(makeAmbiguous("missing-marker", "CMISSING"));
          yield* outbox.upsert(makeAmbiguous("duplicate-marker", "CDUPLICATE"));
          yield* outbox.upsert(
            makeAmbiguous("wrong-workspace-marker", "CWRONG", "TOTHER")
          );
          let updates = 0;
          let wrongWorkspaceLookups = 0;
          const client = {
            chat: {
              postMessage: () => Promise.reject(new Error("not used")),
              update: () => {
                updates += 1;
                return Promise.resolve({ ok: true });
              },
            },
            conversations: {
              replies: ({ channel }: { readonly channel: string }) => {
                if (channel === "CWRONG") {
                  wrongWorkspaceLookups += 1;
                }
                let messages: readonly unknown[] = [];
                if (channel === "CDUPLICATE") {
                  messages = ["245.401", "245.402"].map((ts) => ({
                    metadata: {
                      event_payload: {
                        presentation_marker: "duplicate-marker",
                      },
                      event_type: "laborer_permission_presentation_v1",
                    },
                    thread_ts: presentationRequest.rootTs,
                    ts,
                    user: "U245LABORER",
                  }));
                } else if (channel === "CMISSING") {
                  messages = [
                    {
                      metadata: {
                        event_payload: {
                          presentation_marker: "missing-marker",
                        },
                        event_type: "laborer_permission_presentation_v1",
                      },
                      thread_ts: "wrong-thread",
                      ts: "245.403",
                      user: "U245LABORER",
                    },
                    {
                      metadata: {
                        event_payload: {
                          presentation_marker: "missing-marker",
                        },
                        event_type: "laborer_permission_presentation_v1",
                      },
                      thread_ts: presentationRequest.rootTs,
                      ts: "245.404",
                      user: "UOTHERBOT",
                    },
                  ];
                }
                return Promise.resolve({ messages, ok: true });
              },
            },
          } as unknown as WebClient;
          const presenter = makeSlackAcpPermissionPresenter(client, {
            botUserId: "U245LABORER",
            outbox,
            retry: {
              attempts: 1,
              deadlineMillis: 20,
              initialBackoffMillis: 1,
              maxBackoffMillis: 1,
            },
            workspaceId: presentationRequest.workspaceId,
          });
          yield* presenter.recover?.(() => Effect.succeed("cancelled")) ??
            Effect.void;
          const diagnosed = yield* waitForOutboxEntries(
            outbox,
            (entries) =>
              entries.length === 3 &&
              entries.every(({ diagnostic }) => diagnostic !== null)
          );
          assert.deepStrictEqual(
            diagnosed.map(({ diagnostic }) => diagnostic).sort(),
            [
              "duplicate-presentation-marker",
              "live-reconciliation-budget-exhausted",
              "workspace-scope-mismatch",
            ]
          );
          assert.strictEqual(
            diagnosed.find(({ id }) => id === "missing-marker")?.status,
            "posting-ambiguous"
          );
          assert.strictEqual(updates, 0);
          assert.strictEqual(wrongWorkspaceLookups, 0);
        })
      )
  );
});
