/** THROWAWAY PROTOTYPE: tests the user-authored Action composition surface. */
import { Effect, Schema } from "effect";

export interface ActionProgress {
  readonly details: unknown | null;
  readonly message: string;
}

export interface ActionContext {
  readonly executionId: string;
  readonly reportProgress: (progress: ActionProgress) => Effect.Effect<void>;
}

export interface ActionDefinition<Name extends string = string> {
  readonly description: string;
  readonly execute: (
    input: unknown,
    context: ActionContext
  ) => Effect.Effect<unknown, unknown>;
  readonly inputJsonSchema: unknown;
  readonly inputSchema: Schema.Top;
  readonly name: Name;
  readonly resultJsonSchema: unknown;
  readonly resultSchema: Schema.Top;
  readonly validateInput: (input: unknown) => Effect.Effect<void, unknown>;
}

interface ActionDefinitionOptions<Name extends string, Input, Result, Error> {
  readonly description: string;
  readonly input: Schema.Codec<Input, unknown>;
  readonly name: Name;
  readonly result: Schema.Codec<Result, unknown>;
  readonly run: (
    input: Input,
    context: ActionContext
  ) => Effect.Effect<Result, Error>;
}

export const defineAction = <const Name extends string, Input, Result, Error>(
  options: ActionDefinitionOptions<Name, Input, Result, Error>
): ActionDefinition<Name> => ({
  name: options.name,
  description: options.description,
  inputSchema: options.input,
  resultSchema: options.result,
  inputJsonSchema: Schema.toJsonSchemaDocument(options.input),
  resultJsonSchema: Schema.toJsonSchemaDocument(options.result),
  validateInput: (input) =>
    Schema.decodeUnknownEffect(options.input)(input).pipe(Effect.asVoid),
  execute: (input, context) =>
    Schema.decodeUnknownEffect(options.input)(input).pipe(
      Effect.flatMap((decoded) => options.run(decoded, context)),
      Effect.flatMap((result) =>
        Schema.encodeUnknownEffect(options.result)(result)
      )
    ),
});

export interface ActionCatalogItem {
  readonly description: string;
  readonly name: string;
}

export interface ConversationAgentAuthoringContext {
  readonly actionInstructions: string;
  readonly actions: readonly ActionCatalogItem[];
}

export interface ConversationAgentDefinition {
  readonly provider: string;
  readonly systemPrompt: string;
}

interface ApplicationOptions {
  readonly actions: readonly ActionDefinition[];
  readonly cliCommand: string;
  readonly conversationAgent: (
    context: ConversationAgentAuthoringContext
  ) => ConversationAgentDefinition;
}

const renderActionInstructions = (
  cliCommand: string,
  actions: readonly ActionCatalogItem[]
): string => {
  const catalog = actions
    .map((action) => `- ${action.name}: ${action.description}`)
    .join("\n");

  return `You may delegate durable asynchronous work through ${cliCommand}.

Available Actions:
${catalog}

Use \`${cliCommand} describe <action>\` for its exact JSON input schema.
Pipe one JSON value to \`${cliCommand} start <action>\` through stdin.
Starting an Action returns an execution ID immediately. Retain that ID.
Use \`${cliCommand} get <execution-id>\` when you need its latest bounded status.
Do not poll aggressively; execution events will wake this conversation.`;
};

export const defineApplication = (options: ApplicationOptions) => {
  const actions = options.actions.map(({ description, name }) => ({
    description,
    name,
  }));
  const actionInstructions = renderActionInstructions(
    options.cliCommand,
    actions
  );

  return {
    actionInstructions,
    actions: options.actions,
    catalog: actions,
    cliCommand: options.cliCommand,
    conversationAgent: options.conversationAgent({
      actionInstructions,
      actions,
    }),
  } as const;
};
