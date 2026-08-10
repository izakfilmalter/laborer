/** True only for HTTPS Slack message or thread permalinks understood by the planner. */
export const isSlackMessageUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    const isSlackHost =
      url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')
    if (url.protocol !== 'https:' || !isSlackHost) {
      return false
    }

    const segments = url.pathname.split('/').filter(Boolean)
    const isArchiveMessage =
      segments[0] === 'archives' &&
      segments.length >= 3 &&
      segments[2]?.startsWith('p')
    const isAppMessage =
      segments[0] === 'client' &&
      ((segments[3] === 'thread' && segments.length >= 5) ||
        segments[3]?.startsWith('p') === true)
    return isArchiveMessage || isAppMessage
  } catch {
    return false
  }
}
