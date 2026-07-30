import type { WebClient } from "@slack/web-api";
import { Effect, Schema } from "effect";
import { SlackRuntimeIdentity } from "./config.ts";
import { SlackStartupError } from "./errors.ts";

const AuthTestIdentity = Schema.Struct({
  bot_id: Schema.String,
  team: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
});

export const authenticateSlackBot = (
  client: WebClient
): Effect.Effect<SlackRuntimeIdentity, SlackStartupError> =>
  Effect.tryPromise({
    try: () => client.auth.test(),
    catch: () =>
      SlackStartupError.make({
        operation: "auth.test",
        reason: "request-failed",
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AuthTestIdentity)),
    Effect.mapError((error) =>
      error instanceof SlackStartupError
        ? error
        : SlackStartupError.make({
            operation: "auth.test",
            reason: "required-bot-identity-missing",
          })
    ),
    Effect.map((identity) =>
      SlackRuntimeIdentity.make({
        botId: identity.bot_id,
        botUserId: identity.user_id,
        teamId: identity.team_id,
        teamName: identity.team,
      })
    )
  );
