import { assert, describe, it } from "@effect/vitest";
import {
  assertAgentCompleted,
  assertNewWorkAfterAcceptedHead,
  assertRecordedRecoveryLineage,
  canRetryGateAfterIncompleteRepair,
  classifyBranchRecovery,
} from "../.sandcastle/agent-completion/index.ts";

const missingCompletionPattern = /did not emit its completion signal/;
const missingNewWorkPattern = /without work after its accepted head/;
const unrelatedRecoveryPattern = /does not descend from accepted head/;
const unrecordedCommitsPattern = /unrecorded commits/;

describe("Sandcastle agent completion gates", () => {
  it("rejects an agent run without the explicit completion signal", () => {
    assert.throws(
      () => assertAgentCompleted({}, "implementation for #42"),
      missingCompletionPattern
    );
  });

  it("accepts an explicit completion signal", () => {
    assert.doesNotThrow(() =>
      assertAgentCompleted(
        { completionSignal: "<promise>COMPLETE</promise>" },
        "implementation for #42"
      )
    );
  });

  it("retries the gate when an infrastructure-blocked repair leaves its clean head unchanged", () => {
    assert.isTrue(
      canRetryGateAfterIncompleteRepair({}, "reviewed", "reviewed")
    );
    assert.isFalse(
      canRetryGateAfterIncompleteRepair(
        { completionSignal: "<promise>COMPLETE</promise>" },
        "reviewed",
        "reviewed"
      )
    );
    assert.isFalse(
      canRetryGateAfterIncompleteRepair({}, "reviewed", "unconfirmed-change")
    );
  });

  it("requires work after the runner's durable accepted head", () => {
    assert.throws(
      () => assertNewWorkAfterAcceptedHead("abc", "abc", "Issue #42"),
      missingNewWorkPattern
    );
    assert.doesNotThrow(() =>
      assertNewWorkAfterAcceptedHead("abc", "def", "Issue #42")
    );
  });

  it("recovers only runner-recorded completed or in-progress heads", () => {
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "base",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: undefined,
        progressHead: undefined,
        uiReviewedHead: undefined,
      }),
      "build"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: "done",
        currentHead: "done",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: undefined,
        progressHead: undefined,
        uiReviewedHead: undefined,
      }),
      "publish"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "reviewed",
        gatePassedHead: undefined,
        gatePendingHead: "reviewed",
        implementationHead: undefined,
        progressHead: "reviewed",
        uiReviewedHead: undefined,
      }),
      "gate"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "progress",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: undefined,
        progressHead: "progress",
        uiReviewedHead: undefined,
      }),
      "review"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "implementation",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: "implementation",
        progressHead: undefined,
        uiReviewedHead: undefined,
      }),
      "ui"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "ui-reviewed",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: undefined,
        progressHead: "progress",
        uiReviewedHead: "ui-reviewed",
      }),
      "code-review"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "passed",
        gatePassedHead: "passed",
        gatePendingHead: "passed",
        implementationHead: undefined,
        progressHead: "passed",
        uiReviewedHead: undefined,
      }),
      "complete"
    );
    assert.strictEqual(
      classifyBranchRecovery({
        acceptedHead: "base",
        completedHead: undefined,
        currentHead: "base",
        gatePassedHead: undefined,
        gatePendingHead: undefined,
        implementationHead: "base",
        progressHead: undefined,
        uiReviewedHead: undefined,
      }),
      "ui"
    );
    assert.throws(
      () =>
        classifyBranchRecovery({
          acceptedHead: "base",
          completedHead: "done",
          currentHead: "unrecorded",
          gatePassedHead: "passed",
          gatePendingHead: "reviewed",
          implementationHead: "implementation",
          progressHead: "progress",
          uiReviewedHead: "ui-reviewed",
        }),
      unrecordedCommitsPattern
    );
  });

  it("allows a runner-recorded recovery head to lag a newly advanced base", () => {
    let ancestryChecks = 0;
    assert.doesNotThrow(() =>
      assertRecordedRecoveryLineage(undefined, "progress", () => {
        ancestryChecks += 1;
        return false;
      })
    );
    assert.strictEqual(ancestryChecks, 0);
  });

  it("retains ancestry enforcement for shared spec progress", () => {
    assert.throws(
      () => assertRecordedRecoveryLineage("accepted", "progress", () => false),
      unrelatedRecoveryPattern
    );
    assert.doesNotThrow(() =>
      assertRecordedRecoveryLineage("accepted", "progress", () => true)
    );
  });
});
