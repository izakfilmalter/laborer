import { assert, describe, it } from "@effect/vitest";
import {
  assertAcceptedHeadIsCurrent,
  assertAgentCompleted,
  assertNewWorkAfterAcceptedHead,
} from "../.sandcastle/agent-completion/index.ts";

const missingCompletionPattern = /did not emit its completion signal/;
const missingNewWorkPattern = /without work after its accepted head/;
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

  it("requires work after the runner's durable accepted head", () => {
    assert.throws(
      () => assertNewWorkAfterAcceptedHead("abc", "abc", "Issue #42"),
      missingNewWorkPattern
    );
    assert.doesNotThrow(() =>
      assertNewWorkAfterAcceptedHead("abc", "def", "Issue #42")
    );
  });

  it("fails closed on unrecorded commits before the next agent run", () => {
    assert.doesNotThrow(() => assertAcceptedHeadIsCurrent("abc", "abc"));
    assert.throws(
      () => assertAcceptedHeadIsCurrent("abc", "unrecorded"),
      unrecordedCommitsPattern
    );
  });
});
