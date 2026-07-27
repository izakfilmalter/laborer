import { assert, describe, it } from "@effect/vitest";
import { BlueGreenReloadPrototype } from "../src/blue-green-reload-prototype/reload-state.ts";

describe("blue/green reload prototype", () => {
  it("hands queued work to green only after blue finishes draining", () => {
    const reload = new BlueGreenReloadPrototype();

    reload.submitWork("turn-1");
    reload.prepare("green");
    reload.beginReload("green");
    reload.submitWork("turn-2");

    assert.deepStrictEqual(reload.snapshot(), {
      activeGenerationId: "blue",
      candidateGenerationId: "green",
      generations: [
        {
          id: "blue",
          inFlight: ["turn-1"],
          phase: "draining",
        },
        {
          id: "green",
          inFlight: [],
          phase: "prepared",
        },
      ],
      queuedWork: ["turn-2"],
    });

    reload.completeWork("turn-1");

    assert.deepStrictEqual(reload.snapshot(), {
      activeGenerationId: "green",
      candidateGenerationId: null,
      generations: [
        {
          id: "blue",
          inFlight: [],
          phase: "released",
        },
        {
          id: "green",
          inFlight: ["turn-2"],
          phase: "active",
        },
      ],
      queuedWork: [],
    });
  });

  it("leaves blue active when green preparation fails", () => {
    const reload = new BlueGreenReloadPrototype();

    const outcome = reload.prepare("green", false);

    assert.strictEqual(
      outcome,
      "preparation failed: green; active generation unchanged"
    );
    assert.deepStrictEqual(reload.snapshot(), {
      activeGenerationId: "blue",
      candidateGenerationId: null,
      generations: [
        {
          id: "blue",
          inFlight: [],
          phase: "active",
        },
      ],
      queuedWork: [],
    });
  });

  it("cuts over immediately when blue has no in-flight work", () => {
    const reload = new BlueGreenReloadPrototype();

    reload.prepare("green");
    const outcome = reload.beginReload("green");

    assert.strictEqual(outcome, "reloaded immediately to green");
    assert.deepStrictEqual(reload.snapshot(), {
      activeGenerationId: "green",
      candidateGenerationId: null,
      generations: [
        {
          id: "blue",
          inFlight: [],
          phase: "released",
        },
        {
          id: "green",
          inFlight: [],
          phase: "active",
        },
      ],
      queuedWork: [],
    });
  });

  it("does not schedule duplicate work while it is active or queued", () => {
    const reload = new BlueGreenReloadPrototype();

    assert.strictEqual(reload.submitWork("turn-1"), "started turn-1 on blue");
    assert.strictEqual(
      reload.submitWork("turn-1"),
      "ignored duplicate work: turn-1"
    );
    reload.prepare("green");
    reload.beginReload("green");
    assert.strictEqual(
      reload.submitWork("turn-2"),
      "queued turn-2 durably while blue drains"
    );
    assert.strictEqual(
      reload.submitWork("turn-2"),
      "ignored duplicate work: turn-2"
    );

    assert.deepStrictEqual(reload.snapshot().queuedWork, ["turn-2"]);
    reload.completeWork("turn-1");
    assert.deepStrictEqual(
      reload
        .snapshot()
        .generations.find((generation) => generation.id === "green")?.inFlight,
      ["turn-2"]
    );
  });

  it("keeps exactly one runtime owner through repeated cutovers", () => {
    const reload = new BlueGreenReloadPrototype();
    const assertSingleOwner = (): void => {
      const state = reload.snapshot();
      const owners = state.generations.filter(
        (generation) =>
          generation.phase === "active" || generation.phase === "draining"
      );
      assert.strictEqual(owners.length, 1);
      assert.strictEqual(owners[0]?.id, state.activeGenerationId);
    };

    assertSingleOwner();
    reload.submitWork("turn-blue");
    assertSingleOwner();
    reload.prepare("green");
    assertSingleOwner();
    reload.beginReload("green");
    assertSingleOwner();
    reload.completeWork("turn-blue");
    assertSingleOwner();
    reload.prepare("violet");
    assertSingleOwner();
    reload.beginReload("violet");
    assertSingleOwner();

    assert.strictEqual(reload.snapshot().activeGenerationId, "violet");
  });
});
