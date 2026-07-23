/** THROWAWAY PROTOTYPE: makes the proposed Action API tangible. */
import { Console, Data, Effect, Exit, Ref } from "effect";
import { application } from "./example-application.ts";
import {
  type ExecutionRecord,
  type PrototypeState,
  readPrototypeState,
  resetPrototypeState,
  writePrototypeState,
} from "./prototype-store.ts";

const printJson = (label: string, value: unknown) =>
  Console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

class UnknownActionError extends Data.TaggedError("UnknownActionError")<{
  readonly name: string;
}> {}

class UnknownExecutionError extends Data.TaggedError("UnknownExecutionError")<{
  readonly executionId: string;
}> {}

const findAction = (name: string) => {
  const action = application.actions.find(
    (candidate) => candidate.name === name
  );
  return action
    ? Effect.succeed(action)
    : Effect.fail(new UnknownActionError({ name }));
};

const findExecution = (state: PrototypeState, executionId: string) => {
  const execution = state.executions.find(({ id }) => id === executionId);
  return execution
    ? Effect.succeed(execution)
    : Effect.fail(new UnknownExecutionError({ executionId }));
};

const replaceExecution = (
  state: PrototypeState,
  replacement: ExecutionRecord
): PrototypeState => ({
  ...state,
  executions: state.executions.map((execution) =>
    execution.id === replacement.id ? replacement : execution
  ),
});

export const listActions = Effect.succeed({ actions: application.catalog });

export const describeAction = (name: string) =>
  Effect.gen(function* () {
    const action = yield* findAction(name);
    return {
      description: action.description,
      inputSchema: action.inputJsonSchema,
      name: action.name,
      resultSchema: action.resultJsonSchema,
    };
  });

export const showAgentInstructions = Effect.succeed({
  actionInstructions: application.actionInstructions,
  conversationAgent: application.conversationAgent,
});

export const startAction = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const action = yield* findAction(name);
    yield* action.validateInput(input);
    const state = yield* readPrototypeState;
    const executionId = `execution-${state.nextExecutionNumber.toString().padStart(3, "0")}`;
    const execution: ExecutionRecord = {
      action: name,
      error: null,
      id: executionId,
      input,
      progress: null,
      result: null,
      status: "queued",
    };
    yield* writePrototypeState({
      executions: [...state.executions, execution],
      nextExecutionNumber: state.nextExecutionNumber + 1,
    });
    return { executionId, status: execution.status } as const;
  });

export const getExecution = (executionId: string) =>
  Effect.gen(function* () {
    const state = yield* readPrototypeState;
    return yield* findExecution(state, executionId);
  });

export const advanceExecution = (executionId: string) =>
  Effect.gen(function* () {
    const state = yield* readPrototypeState;
    const execution = yield* findExecution(state, executionId);

    if (execution.status === "queued") {
      const running: ExecutionRecord = {
        ...execution,
        progress: { message: "The prototype runtime claimed this Action." },
        status: "running",
      };
      const nextState = replaceExecution(state, running);
      yield* writePrototypeState(nextState);
      return nextState;
    }

    if (execution.status !== "running") {
      return state;
    }

    const action = yield* findAction(execution.action);
    const latestProgress = yield* Ref.make(execution.progress);
    const outcome = yield* Effect.exit(
      action.execute(execution.input, {
        executionId,
        reportProgress: (progress) => Ref.set(latestProgress, progress),
      })
    );
    const progress = yield* Ref.get(latestProgress);
    const completed: ExecutionRecord = Exit.isSuccess(outcome)
      ? {
          ...execution,
          progress,
          result: outcome.value,
          status: "succeeded",
        }
      : {
          ...execution,
          error: "The Action failed. Raw provider output remains private.",
          progress,
          status: "failed",
        };
    const nextState = replaceExecution(state, completed);
    yield* writePrototypeState(nextState);
    return nextState;
  });

export const resetDemo = resetPrototypeState;

export const runDemo = Effect.gen(function* () {
  yield* resetPrototypeState;
  yield* Console.log(
    "THROWAWAY PROTOTYPE — user-authored Action catalog and conversation agent"
  );
  yield* printJson("derived Action catalog", yield* listActions);
  yield* printJson(
    "coding-task contract",
    yield* describeAction("coding-task")
  );
  yield* printJson("conversation-agent authoring context", {
    actionInstructions: application.actionInstructions,
    conversationAgent: application.conversationAgent,
  });

  const accepted = yield* startAction("coding-task", {
    brief: "Add the smallest working conversation-to-execution tracer",
    workingDirectory: "/tmp/laborer-worktree",
  });
  yield* printJson("start response", accepted);
  yield* printJson("state after durable acceptance", yield* readPrototypeState);
  yield* printJson(
    "state after execution runtime claims work",
    yield* advanceExecution(accepted.executionId)
  );
  yield* printJson(
    "state after Action completion",
    yield* advanceExecution(accepted.executionId)
  );
  yield* printJson("get response", yield* getExecution(accepted.executionId));
  yield* Console.log(
    "\nVERDICT TARGET: Does this authoring definition and CLI vocabulary feel small, general, and controllable enough?"
  );
});
