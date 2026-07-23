/** THROWAWAY PROTOTYPE: the complete user-authored application definition. */
import { Effect, Schema } from "effect";
import { defineAction, defineApplication } from "./toolkit.ts";

const codingTask = defineAction({
  name: "coding-task",
  description:
    "Complete a bounded coding task in a working directory and report the outcome.",
  input: Schema.Struct({
    brief: Schema.NonEmptyString,
    workingDirectory: Schema.NonEmptyString,
  }),
  result: Schema.Struct({
    summary: Schema.NonEmptyString,
    changedFiles: Schema.Array(Schema.String),
  }),
  run: (input, context) =>
    Effect.gen(function* () {
      yield* context.reportProgress({
        details: { workingDirectory: input.workingDirectory },
        message: "OpenCode is working on the coding task.",
      });

      return {
        changedFiles: ["src/example.ts"],
        summary: `Completed: ${input.brief}`,
      };
    }),
});

export const application = defineApplication({
  cliCommand: "laborer-actions",
  actions: [codingTask],
  conversationAgent: ({ actionInstructions }) => ({
    provider: "opencode",
    systemPrompt: `You are the user-authored conversation agent for this Laborer root.
You may answer directly, use your own tools, or delegate an Action.
Only produce a public reply when it is useful to the people in the work thread.

${actionInstructions}`,
  }),
});
