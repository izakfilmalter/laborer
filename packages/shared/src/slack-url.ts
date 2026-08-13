export const SLACK_MESSAGE_URL_MAX_LENGTH = 2048

const SLACK_ID_PATTERN = /^[A-Z0-9]+$/u
const SLACK_MESSAGE_TOKEN_PATTERN = /^p\d+$/u
const SLACK_THREAD_TOKEN_PATTERN = /^[A-Z0-9]+-\d+(?:\.\d+)?$/u

/** True only for HTTPS Slack message or thread permalinks understood by the planner. */
export const isSlackMessageUrl = (value: string): boolean => {
  if (value.length > SLACK_MESSAGE_URL_MAX_LENGTH) {
    return false
  }
  try {
    const url = new URL(value)
    const isSlackHost =
      url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')
    if (
      url.protocol !== 'https:' ||
      !isSlackHost ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) {
      return false
    }

    const segments = url.pathname.split('/').filter(Boolean)
    const isArchiveMessage =
      segments[0] === 'archives' &&
      segments.length === 3 &&
      SLACK_ID_PATTERN.test(segments[1] ?? '') &&
      SLACK_MESSAGE_TOKEN_PATTERN.test(segments[2] ?? '')
    const isAppMessage =
      segments[0] === 'client' &&
      segments.length >= 4 &&
      SLACK_ID_PATTERN.test(segments[1] ?? '') &&
      SLACK_ID_PATTERN.test(segments[2] ?? '') &&
      ((segments.length === 5 &&
        segments[3] === 'thread' &&
        SLACK_THREAD_TOKEN_PATTERN.test(segments[4] ?? '')) ||
        (segments.length === 4 &&
          SLACK_MESSAGE_TOKEN_PATTERN.test(segments[3] ?? '')))
    return isArchiveMessage || isAppMessage
  } catch {
    return false
  }
}
