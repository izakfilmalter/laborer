import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { SQLiteStateAdapter } from "../src/chat-plane/sqlite-state-adapter.ts";

const NOT_CONNECTED = /not connected/;

const withAdapter = async <A>(
  operation: (input: {
    readonly adapter: SQLiteStateAdapter;
    readonly advance: (milliseconds: number) => void;
    readonly path: string;
  }) => Promise<A>
): Promise<A> => {
  const directory = await mkdtemp(resolve(tmpdir(), "laborer-chat-state-"));
  const path = resolve(directory, "chat.sqlite");
  let now = 1000;
  const adapter = new SQLiteStateAdapter({ now: () => now, path });
  await adapter.connect();
  try {
    return await operation({
      adapter,
      advance: (milliseconds) => {
        now += milliseconds;
      },
      path,
    });
  } finally {
    await adapter.disconnect();
    await rm(directory, { force: true, recursive: true });
  }
};

const queueEntry = (id: string, expiresAt = 10_000) => ({
  enqueuedAt: 1000,
  expiresAt,
  message: { id } as never,
});

describe("SQLite Chat SDK state adapter", () => {
  it("persists every durable state category across adapter restarts", () =>
    withAdapter(async ({ adapter, path }) => {
      await adapter.subscribe("slack:C1:thread-1");
      await adapter.set("thread-state", { durable: true });
      await adapter.appendToList("history", "first", { maxLength: 10 });
      await adapter.enqueue("queued-thread", queueEntry("pending"), 10);
      const lock = await adapter.acquireLock("locked-thread", 1000);
      assert.isNotNull(lock);
      await adapter.disconnect();

      const restarted = new SQLiteStateAdapter({ now: () => 1000, path });
      await restarted.connect();
      try {
        assert.isTrue(await restarted.isSubscribed("slack:C1:thread-1"));
        assert.deepStrictEqual(await restarted.get("thread-state"), {
          durable: true,
        });
        assert.deepStrictEqual(await restarted.getList("history"), ["first"]);
        assert.deepNestedInclude(await restarted.dequeue("queued-thread"), {
          message: { id: "pending" },
        });
        assert.isNull(await restarted.acquireLock("locked-thread", 1000));
        await restarted.unsubscribe("slack:C1:thread-1");
        assert.isFalse(await restarted.isSubscribed("slack:C1:thread-1"));
      } finally {
        await restarted.disconnect();
      }
    }));

  it("enforces lock ownership, extension, expiry, and force-release", () =>
    withAdapter(async ({ adapter, advance }) => {
      const first = await adapter.acquireLock("thread", 100);
      assert.isNotNull(first);
      assert.isNull(await adapter.acquireLock("thread", 100));
      if (first === null) {
        return;
      }

      assert.isTrue(await adapter.extendLock(first, 200));
      advance(199);
      assert.isNull(await adapter.acquireLock("thread", 100));
      advance(2);
      const replacement = await adapter.acquireLock("thread", 100);
      assert.isNotNull(replacement);
      assert.isFalse(await adapter.extendLock(first, 100));

      await adapter.releaseLock(first);
      assert.isNull(await adapter.acquireLock("thread", 100));
      await adapter.forceReleaseLock("thread");
      assert.isNotNull(await adapter.acquireLock("thread", 100));
    }));

  it("sets absent cache keys atomically and permits replacement after TTL", () =>
    withAdapter(async ({ adapter, advance }) => {
      assert.isTrue(await adapter.setIfNotExists("dedupe", "first", 100));
      assert.isFalse(await adapter.setIfNotExists("dedupe", "second", 100));
      assert.strictEqual(await adapter.get("dedupe"), "first");
      advance(100);
      assert.isNull(await adapter.get("dedupe"));
      assert.isTrue(await adapter.setIfNotExists("dedupe", "third"));
      assert.strictEqual(await adapter.get("dedupe"), "third");
      await adapter.delete("dedupe");
      assert.isNull(await adapter.get("dedupe"));
    }));

  it("serializes set-if-absent across adapter connections", () =>
    withAdapter(async ({ adapter, path }) => {
      const competitor = new SQLiteStateAdapter({ path });
      await competitor.connect();
      try {
        const outcomes = await Promise.all([
          adapter.setIfNotExists("shared-dedupe", "first"),
          competitor.setIfNotExists("shared-dedupe", "second"),
        ]);
        assert.strictEqual(outcomes.filter(Boolean).length, 1);
        assert.include(["first", "second"], await adapter.get("shared-dedupe"));
      } finally {
        await competitor.disconnect();
      }
    }));

  it("keeps FIFO queue order while dropping oldest overflow and stale entries", () =>
    withAdapter(async ({ adapter, advance }) => {
      assert.strictEqual(
        await adapter.enqueue("thread", queueEntry("one"), 2),
        1
      );
      assert.strictEqual(
        await adapter.enqueue("thread", queueEntry("two"), 2),
        2
      );
      assert.strictEqual(
        await adapter.enqueue("thread", queueEntry("three"), 2),
        2
      );
      assert.deepNestedInclude(await adapter.dequeue("thread"), {
        message: { id: "two" },
      });
      assert.deepNestedInclude(await adapter.dequeue("thread"), {
        message: { id: "three" },
      });
      assert.isNull(await adapter.dequeue("thread"));

      await adapter.enqueue("thread", queueEntry("stale", 1001), 2);
      advance(2);
      assert.strictEqual(await adapter.queueDepth("thread"), 0);
      assert.isNull(await adapter.dequeue("thread"));
      assert.strictEqual(
        await adapter.enqueue("thread", queueEntry("already-stale", 1002), 2),
        0
      );
    }));

  it("appends lists in order, keeps newest bound, and refreshes TTL", () =>
    withAdapter(async ({ adapter, advance }) => {
      await adapter.appendToList("history", "one", {
        maxLength: 2,
        ttlMs: 100,
      });
      advance(90);
      await adapter.appendToList("history", "two", {
        maxLength: 2,
        ttlMs: 100,
      });
      await adapter.appendToList("history", "three", {
        maxLength: 2,
        ttlMs: 100,
      });
      assert.deepStrictEqual(await adapter.getList("history"), [
        "two",
        "three",
      ]);
      advance(99);
      assert.deepStrictEqual(await adapter.getList("history"), [
        "two",
        "three",
      ]);
      advance(1);
      assert.deepStrictEqual(await adapter.getList("history"), []);
    }));

  it("does not resurrect expired list entries beyond a cleanup batch", () =>
    withAdapter(async ({ adapter, advance }) => {
      for (let index = 0; index < 300; index += 1) {
        await adapter.appendToList("history", index, { ttlMs: 1 });
      }

      advance(1);
      await adapter.appendToList("history", "current");
      assert.deepStrictEqual(await adapter.getList("history"), ["current"]);
    }));

  it("deletes a bounded list through the adapter's shared delete primitive", () =>
    withAdapter(async ({ adapter }) => {
      await adapter.appendToList("transcript", "message", { maxLength: 10 });
      await adapter.delete("transcript");
      assert.deepStrictEqual(await adapter.getList("transcript"), []);
    }));

  it("requires an active connection", async () => {
    const adapter = new SQLiteStateAdapter({
      path: resolve(tmpdir(), "laborer-never-opened.sqlite"),
    });
    let failure: unknown;
    try {
      await adapter.get("key");
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.match(failure.message, NOT_CONNECTED);
  });
});
