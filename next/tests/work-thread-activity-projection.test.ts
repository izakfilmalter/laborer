import { describe, expect, it } from "vitest";
import {
  ApplicationEventState,
  EventId,
  HandlerOutcomeState,
  NormalizedMessage,
  OutboundItem,
  PrototypeState,
  ThreadId,
  TurnId,
  TurnState,
  WorkThreadState,
} from "../src/prototype/domain.ts";
import {
  makeWorkThreadActivityProjection,
  observePrototypeWorkThreads,
  type WorkThreadActivityObservation,
} from "../src/slack/work-thread-activity-projection.ts";

const message = NormalizedMessage.make({
  authorKind: "human",
  authorSlackId: "U123",
  classification: "input",
  id: "message-1" as never,
  isActivation: true,
  slackTs: "1000.000001",
  text: "private prompt that must not be projected",
});

const thread = (
  id: string,
  overrides: Partial<WorkThreadState> = {}
): WorkThreadState =>
  WorkThreadState.make({
    activationEventId: EventId.make(`event:${id}`),
    activationTs: "1000.000001",
    applicationEvents: [],
    applicationInputQueue: [],
    channelId: "C123",
    context: [],
    contextAttempts: 0,
    contextIsPartial: false,
    contextRetryAtMillis: null,
    contextStatus: "ready",
    id: ThreadId.make(id),
    initializationStatus: "completed",
    outbox: [],
    rootTs: "1000.000001",
    turns: [],
    unassigned: [],
    workingDirectory: null,
    workspaceId: "TFIRST",
    ...overrides,
  });

const state = (...threads: readonly WorkThreadState[]): PrototypeState =>
  PrototypeState.make({
    acknowledgements: [],
    completionReactions: [],
    conversationStreamRateBudgets: [],
    conversationStreams: [],
    conversationStreamTombstones: [],
    ignoredInbound: [],
    schemaVersion: 1,
    seenEventIds: [],
    threads: [...threads],
  });

const observed = (
  id: string,
  activity: WorkThreadActivityObservation["activity"],
  evidenceAtUnixMs: number
): WorkThreadActivityObservation => ({
  activity,
  evidenceAtUnixMs,
  executions: [],
  id,
  label: `Thread ${id}`,
  workspaceId: "TFIRST",
});

describe("work-thread activity projection", () => {
  it("derives queueing, running, delivery, blocker, failure, and Execution precedence from daemon state", () => {
    const runningTurn = TurnState.make({
      attempts: [],
      blocked: null,
      context: [],
      id: TurnId.make("turn-running"),
      messages: [message],
      outcome: null,
      status: "running",
    });
    const settledFailure = TurnState.make({
      attempts: [],
      blocked: null,
      context: [],
      id: TurnId.make("turn-failed"),
      messages: [message],
      outcome: HandlerOutcomeState.make({
        category: "exit",
        kind: "failure",
        safeDetail: null,
      }),
      status: "failed",
    });
    const outbound = (
      turnId: string,
      status: "blocked" | "delivered" | "pending"
    ) =>
      OutboundItem.make({
        deliveryAttempts: 1,
        id: `outbound:${turnId}`,
        kind: "operational_notice",
        lastErrorCategory: null,
        replyId: null,
        retryAtMillis: null,
        slackTs: status === "delivered" ? "2000.000001" : null,
        status,
        text: "sanitized notice",
        turnId: TurnId.make(turnId),
      });
    const snapshot = state(
      thread("queued", { unassigned: [message] }),
      thread("running", { turns: [runningTurn] }),
      thread("delivery", { outbox: [outbound("delivery", "pending")] }),
      thread("blocked", { outbox: [outbound("blocked", "blocked")] }),
      thread("failed-settled", {
        outbox: [outbound("turn-failed", "delivered")],
        turns: [settledFailure],
      }),
      thread("ordinary-settled", {
        outbox: [outbound("ordinary-settled", "delivered")],
      }),
      thread("execution-running"),
      thread("execution-blocked"),
      thread("terminal-event-awaiting-response", {
        applicationEvents: [
          ApplicationEventState.make({
            blocked: null,
            eventId: "execution-event:terminal",
            outcome: null,
            payload: {
              privateResult: "implementation response must not be projected",
            },
            source: "execution",
            status: "pending",
          }),
        ],
      })
    );

    expect(
      observePrototypeWorkThreads(snapshot, "TFIRST", [
        {
          actionName: "fixture/run",
          conversationId: "execution-running",
          executionId: "execution:running",
          lifecycle: "running",
          startedAtUnixMs: 900,
          workspaceId: "TFIRST",
        },
        {
          actionName: "fixture/blocked",
          conversationId: "execution-blocked",
          executionId: "execution:blocked",
          lifecycle: "recovery-blocked",
          startedAtUnixMs: 800,
          workspaceId: "TFIRST",
        },
      ]).map(({ activity, id, label }) => ({ activity, id, label }))
    ).toEqual([
      { activity: "in-progress", id: "queued", label: "C123 · 1000.000001" },
      { activity: "in-progress", id: "running", label: "C123 · 1000.000001" },
      { activity: "in-progress", id: "delivery", label: "C123 · 1000.000001" },
      {
        activity: "needs-attention",
        id: "blocked",
        label: "C123 · 1000.000001",
      },
      {
        activity: "dormant",
        id: "failed-settled",
        label: "C123 · 1000.000001",
      },
      {
        activity: "dormant",
        id: "ordinary-settled",
        label: "C123 · 1000.000001",
      },
      {
        activity: "in-progress",
        id: "execution-running",
        label: "C123 · 1000.000001",
      },
      {
        activity: "needs-attention",
        id: "execution-blocked",
        label: "C123 · 1000.000001",
      },
      {
        activity: "in-progress",
        id: "terminal-event-awaiting-response",
        label: "C123 · 1000.000001",
      },
    ]);
    expect(
      JSON.stringify(observePrototypeWorkThreads(snapshot, "TFIRST"))
    ).not.toContain(message.text);
    expect(
      JSON.stringify(observePrototypeWorkThreads(snapshot, "TFIRST"))
    ).not.toContain("implementation response");
  });

  it("projects queued and running work ahead of dormant work", () => {
    const projection = makeWorkThreadActivityProjection({ now: () => 10_000 });

    projection.observe("TFIRST", [
      observed("queued", "in-progress", 1000),
      observed("running", "in-progress", 2000),
      observed("settled", "dormant", 3000),
    ]);

    expect(projection.snapshot("TFIRST")).toEqual([
      expect.objectContaining({ activity: "in-progress", id: "running" }),
      expect.objectContaining({ activity: "in-progress", id: "queued" }),
      expect.objectContaining({ activity: "dormant", id: "settled" }),
    ]);
  });

  it("nests bounded pending Executions only beneath their durable owner", () => {
    const snapshot = state(thread("owner"), thread("other"));
    const executions = [
      {
        actionName: "fixture/build",
        conversationId: "owner",
        executionId: "execution:stable",
        lifecycle: "allocated",
        startedAtUnixMs: 1500,
        workspaceId: "TFIRST",
      },
    ] as const;

    const observations = observePrototypeWorkThreads(
      snapshot,
      "TFIRST",
      executions
    );
    expect(observations[0]?.executions).toEqual([
      {
        actionName: "fixture/build",
        id: "execution:stable",
        lifecycle: "allocated",
        startedAtUnixMs: 1500,
        workThreadId: "owner",
        workspaceId: "TFIRST",
      },
    ]);
    expect(observations[1]?.executions).toEqual([]);
    const ownerObservation = observations[0];
    const otherObservation = observations[1];
    if (ownerObservation === undefined || otherObservation === undefined) {
      throw new Error("expected both work-thread observations");
    }

    const projection = makeWorkThreadActivityProjection({ now: () => 2000 });
    projection.observe("TFIRST", observations);
    projection.observe("TFIRST", observations);
    expect(projection.snapshot("TFIRST")[0]?.executions).toEqual(
      observations[0]?.executions
    );
    expect(() =>
      projection.observe("TFIRST", [
        {
          ...otherObservation,
          executions: ownerObservation.executions.map((execution) => ({
            ...execution,
            workThreadId: "other",
          })),
        },
      ])
    ).toThrow("pending Execution ownership is inconsistent");

    projection.observe(
      "TFIRST",
      observations.map((observation) => ({ ...observation, executions: [] }))
    );
    expect(
      projection
        .snapshot("TFIRST")
        .flatMap((observation) => observation.executions)
    ).toEqual([]);

    expect(() =>
      observePrototypeWorkThreads(snapshot, "TFIRST", [
        { ...executions[0], workspaceId: "TSECOND" },
      ])
    ).toThrow("pending Execution ownership is inconsistent");
    expect(() =>
      observePrototypeWorkThreads(snapshot, "TFIRST", [
        { ...executions[0], conversationId: "missing" },
      ])
    ).toThrow("pending Execution ownership is inconsistent");
  });

  it("keeps delivery and Conversation blockers visible above ordinary progress", () => {
    const projection = makeWorkThreadActivityProjection({ now: () => 10_000 });

    projection.observe("TFIRST", [
      observed("delivery-blocked", "needs-attention", 2000),
      observed("handler-blocked", "needs-attention", 3000),
      observed("delivery-pending", "in-progress", 4000),
    ]);

    expect(
      projection.snapshot("TFIRST").map(({ activity, id }) => [activity, id])
    ).toEqual([
      ["needs-attention", "handler-blocked"],
      ["needs-attention", "delivery-blocked"],
      ["in-progress", "delivery-pending"],
    ]);
  });

  it("does not hide an older blocked outbox head behind a large pending suffix", () => {
    const blocked = OutboundItem.make({
      deliveryAttempts: 1,
      id: "outbound:blocked-head",
      kind: "operational_notice",
      lastErrorCategory: "permanent",
      replyId: null,
      retryAtMillis: null,
      slackTs: null,
      status: "blocked",
      text: "sanitized notice",
      turnId: TurnId.make("turn-blocked-head"),
    });
    const pending = Array.from({ length: 1024 }, (_, index) =>
      OutboundItem.make({
        ...blocked,
        id: `outbound:pending-${index}`,
        lastErrorCategory: null,
        status: "pending",
        turnId: TurnId.make(`turn-pending-${index}`),
      })
    );

    expect(
      observePrototypeWorkThreads(
        state(thread("blocked-head", { outbox: [blocked, ...pending] })),
        "TFIRST"
      )[0]?.activity
    ).toBe("needs-attention");
  });

  it("moves delivered replies and settled handler failures to dormancy", () => {
    let now = 5000;
    const projection = makeWorkThreadActivityProjection({ now: () => now });
    projection.observe("TFIRST", [
      observed("reply", "in-progress", 1000),
      observed("failed-handler-notice", "in-progress", 1100),
    ]);

    now = 9000;
    projection.observe("TFIRST", [
      observed("reply", "dormant", 8000),
      observed("failed-handler-notice", "dormant", 8100),
    ]);

    expect(projection.snapshot("TFIRST")).toEqual([
      expect.objectContaining({
        activity: "dormant",
        id: "failed-handler-notice",
        stateChangedAtUnixMs: 9000,
      }),
      expect.objectContaining({
        activity: "dormant",
        id: "reply",
        stateChangedAtUnixMs: 9000,
      }),
    ]);
  });

  it("reactivates a dormant activated thread on later participant input", () => {
    let now = 5000;
    const projection = makeWorkThreadActivityProjection({ now: () => now });
    projection.observe("TFIRST", [observed("thread", "dormant", 1000)]);

    now = 7000;
    projection.observe("TFIRST", [observed("thread", "in-progress", 7000)]);

    expect(projection.snapshot("TFIRST")).toEqual([
      expect.objectContaining({
        activity: "in-progress",
        id: "thread",
        stateChangedAtUnixMs: 7000,
      }),
    ]);
  });

  it("retains only the four threads that most recently became dormant", () => {
    const projection = makeWorkThreadActivityProjection({ now: () => 10_000 });
    projection.observe(
      "TFIRST",
      [1, 2, 3, 4, 5].map((index) =>
        observed(`dormant-${index}`, "dormant", index * 1000)
      )
    );

    expect(projection.snapshot("TFIRST").map(({ id }) => id)).toEqual([
      "dormant-5",
      "dormant-4",
      "dormant-3",
      "dormant-2",
    ]);
  });

  it("isolates workspaces and replaces stale state on restart snapshots", () => {
    const first = makeWorkThreadActivityProjection({ now: () => 10_000 });
    first.observe("TFIRST", [observed("first", "in-progress", 1000)]);
    first.observe("TSECOND", [
      {
        ...observed("second", "needs-attention", 2000),
        workspaceId: "TSECOND",
      },
    ]);

    expect(first.snapshot("TFIRST").map(({ id }) => id)).toEqual(["first"]);
    expect(first.snapshot("TSECOND").map(({ id }) => id)).toEqual(["second"]);

    const restarted = makeWorkThreadActivityProjection({ now: () => 20_000 });
    restarted.observe("TFIRST", [observed("first", "dormant", 15_000)]);
    expect(restarted.snapshot("TFIRST")).toEqual([
      expect.objectContaining({
        activity: "dormant",
        id: "first",
        stateChangedAtUnixMs: 15_000,
      }),
    ]);
    expect(restarted.snapshot("TSECOND")).toEqual([]);
  });
});
