import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { Array as EffectArray } from "effect";
import type { DeliveryFailureDisposition } from "../prototype/errors.ts";

const DEFAULT_TRANSIENT_RETRY_MILLIS = 1000;

const slackErrorCode = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) {
    return "unknown";
  }
  if ("data" in cause) {
    const data = cause.data;
    if (typeof data === "object" && data !== null && "error" in data) {
      return typeof data.error === "string" ? data.error : "unknown";
    }
  }
  return "unknown";
};

const TRANSIENT_PLATFORM_ERRORS = [
  "fatal_error",
  "internal_error",
  "org_login_required",
  "rate_limited",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
  "team_added_to_org",
  "temporarily_unavailable",
] as const;

const ITEM_PERMANENT_PLATFORM_ERRORS = [
  "attachment_payload_limit_exceeded",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_charset",
  "invalid_form_data",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "invalid_post_type",
  "markdown_text_conflict",
  "metadata_too_large",
  "missing_post_type",
  "msg_blocks_too_long",
  "msg_too_long",
  "no_text",
  "stopped_by_user",
  "too_many_attachments",
  "too_many_contact_cards",
] as const;

const DESTINATION_PERMANENT_PLATFORM_ERRORS = [
  "access_denied",
  "accesslimited",
  "account_inactive",
  "app_access_restricted",
  "cannot_reply_to_message",
  "channel_not_found",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "invalid_auth",
  "is_archived",
  "messages_tab_disabled",
  "method_deprecated",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "team_access_not_granted",
  "team_not_found",
  "token_expired",
  "token_revoked",
  "two_factor_setup_required",
] as const;

const platformDisposition = (category: string): DeliveryFailureDisposition => {
  if (EffectArray.contains(TRANSIENT_PLATFORM_ERRORS, category)) {
    return "transient";
  }
  if (EffectArray.contains(ITEM_PERMANENT_PLATFORM_ERRORS, category)) {
    return "item-permanent";
  }
  if (EffectArray.contains(DESTINATION_PERMANENT_PLATFORM_ERRORS, category)) {
    return "destination-permanent";
  }
  // Unknown platform failures are not retried blindly. Slack explicitly allows
  // undocumented errors, and treating one as destination-wide prevents a hot
  // loop and a speculative notice call with the same broken credentials/path.
  return "destination-permanent";
};

const retryAfterHeaderMillis = (headers: Record<string, string>): number => {
  const retryAfter = Number(headers["retry-after"]);
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter * 1000
    : DEFAULT_TRANSIENT_RETRY_MILLIS;
};

export const classifySlackError = (
  cause: unknown
): {
  readonly category: string;
  readonly disposition: DeliveryFailureDisposition;
  readonly outcomeCertainty?: "definitely-rejected" | "unknown";
  readonly retryAfterMillis: number;
} => {
  if (cause instanceof WebAPIRateLimitedError) {
    return {
      category: "ratelimited",
      disposition: "transient",
      outcomeCertainty: "definitely-rejected",
      retryAfterMillis: cause.retryAfter * 1000,
    };
  }
  if (cause instanceof WebAPIPlatformError) {
    const category = cause.data.error;
    const disposition = platformDisposition(category);
    return {
      category,
      disposition,
      outcomeCertainty:
        category === "fatal_error" ||
        category === "internal_error" ||
        category === "request_timeout"
          ? "unknown"
          : "definitely-rejected",
      retryAfterMillis:
        disposition === "transient" ? DEFAULT_TRANSIENT_RETRY_MILLIS : 0,
    };
  }
  if (cause instanceof WebAPIHTTPError) {
    const isTransient =
      cause.statusCode === 408 ||
      cause.statusCode === 429 ||
      cause.statusCode >= 500;
    return {
      category: `http_${cause.statusCode}`,
      disposition: isTransient ? "transient" : "destination-permanent",
      outcomeCertainty:
        cause.statusCode === 429 ? "definitely-rejected" : "unknown",
      retryAfterMillis: isTransient ? retryAfterHeaderMillis(cause.headers) : 0,
    };
  }
  if (cause instanceof WebAPIRequestError) {
    return {
      category: "request_error",
      disposition: "transient",
      outcomeCertainty: "unknown",
      retryAfterMillis: DEFAULT_TRANSIENT_RETRY_MILLIS,
    };
  }
  const category = slackErrorCode(cause);
  const disposition = platformDisposition(category);
  return {
    category,
    disposition,
    outcomeCertainty:
      category === "fatal_error" ||
      category === "internal_error" ||
      category === "unknown"
        ? "unknown"
        : "definitely-rejected",
    retryAfterMillis:
      disposition === "transient" ? DEFAULT_TRANSIENT_RETRY_MILLIS : 0,
  };
};
