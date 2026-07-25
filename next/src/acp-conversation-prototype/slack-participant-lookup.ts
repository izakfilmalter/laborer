import { WebClient, type WebClientOptions } from "@slack/web-api";
import { Effect, Semaphore } from "effect";

/** Maximum Unicode code points retained from a Slack display or real name. */
export const SLACK_VISIBLE_NAME_CHARACTER_LIMIT = 256;
/** Maximum concurrent users.info transports for one workspace lookup instance. */
export const SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT = 4;
export const SLACK_USERS_INFO_TIMEOUT_MILLIS = 5000;
export const SLACK_USERS_INFO_REQUEST_TIMEOUT_MILLIS = 4000;
const SLACK_USERS_INFO_ABORT_BUFFER_MILLIS = 50;

export interface SlackParticipantLookupShape {
  readonly lookupVisibleName: (slackUserId: string) => Effect.Effect<string>;
}

export interface SlackUsersInfoClient {
  readonly users: {
    readonly info: (request: { readonly user: string }) => Promise<unknown>;
  };
}

export interface SlackParticipantLookupOptions {
  readonly usersInfoTimeoutMillis?: number;
}

export interface BoundedSlackParticipantLookupOptions
  extends SlackParticipantLookupOptions {
  readonly fetch?: WebClientOptions["fetch"];
  readonly logger?: WebClientOptions["logger"];
  readonly requestTimeoutMillis?: number;
  readonly slackApiUrl?: string;
  readonly token: string;
}

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined;

const boundedVisibleName = (value: string): string => {
  let endOffset = 0;
  let characters = 0;
  for (const character of value) {
    if (characters >= SLACK_VISIBLE_NAME_CHARACTER_LIMIT) {
      break;
    }
    endOffset += character.length;
    characters += 1;
  }
  return value.slice(0, endOffset);
};

const isValidXmlCharacter = (value: string): boolean => {
  const codePoint = value.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
      (codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
      (codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff))
  );
};

const xmlSafeVisibleName = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const sanitizedCharacters: string[] = [];
  for (const character of value) {
    if (isValidXmlCharacter(character)) {
      sanitizedCharacters.push(character);
    }
  }
  const trimmed = sanitizedCharacters.join("").trim();
  return trimmed.length === 0 ? null : boundedVisibleName(trimmed);
};

export const safeSlackIdVisibleName = (slackUserId: string): string =>
  xmlSafeVisibleName(slackUserId) ?? "unknown-slack-user";

const visibleNameFromResponse = (
  response: unknown,
  slackUserId: string
): string => {
  const user = property(response, "user");
  const profile = property(user, "profile");
  return (
    xmlSafeVisibleName(property(profile, "display_name")) ??
    xmlSafeVisibleName(property(profile, "real_name")) ??
    xmlSafeVisibleName(property(user, "real_name")) ??
    safeSlackIdVisibleName(slackUserId)
  );
};

const configuredTimeoutMillis = (
  options: SlackParticipantLookupOptions | undefined
): number => {
  const configured = options?.usersInfoTimeoutMillis;
  return configured !== undefined &&
    Number.isSafeInteger(configured) &&
    configured > 0
    ? configured
    : SLACK_USERS_INFO_TIMEOUT_MILLIS;
};

const positiveSafeIntegerOr = (
  candidate: number | undefined,
  fallback: number
): number =>
  candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : fallback;

export const makeSlackParticipantLookup = (
  client: SlackUsersInfoClient,
  options?: SlackParticipantLookupOptions
): SlackParticipantLookupShape => ({
  lookupVisibleName: Effect.fn("SlackParticipantLookup.lookupVisibleName")(
    function* (slackUserId: string) {
      const response = yield* Effect.result(
        Effect.tryPromise({
          try: () => client.users.info({ user: slackUserId }),
          catch: () => "users-info-failed" as const,
        }).pipe(
          Effect.timeoutOrElse({
            duration: configuredTimeoutMillis(options),
            orElse: () => Effect.fail("users-info-timeout" as const),
          })
        )
      );
      if (response._tag === "Failure") {
        yield* Effect.logWarning("Slack participant lookup failed", {
          reason: response.failure,
          slackUserId: safeSlackIdVisibleName(slackUserId),
        });
        return safeSlackIdVisibleName(slackUserId);
      }
      return visibleNameFromResponse(response.success, slackUserId);
    }
  ),
});

/**
 * One semaphore bounds every conversation using this workspace lookup. Each
 * admitted request gets a transport timeout based on its remaining total
 * deadline, including time spent waiting for capacity. The SDK performs no
 * retry and rejects rate limits before that deadline.
 */
export const makeBoundedSlackParticipantLookup = (
  options: BoundedSlackParticipantLookupOptions
): SlackParticipantLookupShape => {
  const effectTimeoutMillis = Math.max(
    2,
    positiveSafeIntegerOr(
      options.usersInfoTimeoutMillis,
      SLACK_USERS_INFO_TIMEOUT_MILLIS
    )
  );
  const configuredRequestTimeoutMillis = positiveSafeIntegerOr(
    options.requestTimeoutMillis,
    SLACK_USERS_INFO_REQUEST_TIMEOUT_MILLIS
  );
  const abortBufferMillis = Math.min(
    SLACK_USERS_INFO_ABORT_BUFFER_MILLIS,
    Math.max(1, Math.floor(effectTimeoutMillis * 0.05))
  );
  const workspaceCapacity = Semaphore.makeUnsafe(
    SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
  );

  return {
    lookupVisibleName: Effect.fn(
      "BoundedSlackParticipantLookup.lookupVisibleName"
    )(function* (slackUserId: string) {
      const deadline = Date.now() + effectTimeoutMillis;
      const response = yield* Effect.result(
        workspaceCapacity
          .withPermit(
            Effect.suspend(() => {
              const remainingMillis = deadline - Date.now();
              if (remainingMillis <= abortBufferMillis) {
                return Effect.fail("users-info-timeout" as const);
              }
              const requestTimeoutMillis = Math.max(
                1,
                Math.min(
                  configuredRequestTimeoutMillis,
                  remainingMillis - abortBufferMillis
                )
              );
              const client = new WebClient(options.token, {
                ...(options.fetch === undefined
                  ? {}
                  : { fetch: options.fetch }),
                ...(options.logger === undefined
                  ? {}
                  : { logger: options.logger }),
                maxRequestConcurrency: 1,
                rejectRateLimitedCalls: true,
                retryConfig: { retries: 0 },
                ...(options.slackApiUrl === undefined
                  ? {}
                  : { slackApiUrl: options.slackApiUrl }),
                timeout: requestTimeoutMillis,
              });
              return Effect.tryPromise({
                try: () => client.users.info({ user: slackUserId }),
                catch: () => "users-info-failed" as const,
              });
            })
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: effectTimeoutMillis,
              orElse: () => Effect.fail("users-info-timeout" as const),
            })
          )
      );
      if (response._tag === "Failure") {
        yield* Effect.logWarning("Slack participant lookup failed", {
          reason: response.failure,
          slackUserId: safeSlackIdVisibleName(slackUserId),
        });
        return safeSlackIdVisibleName(slackUserId);
      }
      return visibleNameFromResponse(response.success, slackUserId);
    }),
  };
};
