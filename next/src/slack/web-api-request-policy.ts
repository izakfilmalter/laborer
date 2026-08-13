export const slackWebApiRequestPolicy = {
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 0 },
  timeout: 10_000,
} as const
