/**
 * Relative timestamps for the pull request conversation.
 *
 * A comment's age is the only thing the timeline says about time, so it has
 * to read the way a person would say it: "just now", "4m", "3h", "2d". The
 * absolute timestamp stays available as a `title` for anyone who needs it.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const YEAR_MS = 365 * DAY_MS

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})

const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * Format an ISO 8601 timestamp as a compact age relative to `now`.
 *
 * Anything older than a week becomes a date, because "43d" stops being
 * information a reader can place. Returns an empty string for timestamps
 * GitHub omitted, so callers can render nothing rather than "Invalid Date".
 */
export function formatRelativeTime(
  isoTimestamp: string,
  now: number = Date.now()
): string {
  const timestamp = Date.parse(isoTimestamp)
  if (Number.isNaN(timestamp)) {
    return ''
  }

  const elapsed = now - timestamp
  if (elapsed < MINUTE_MS) {
    return 'just now'
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`
  }
  if (elapsed < WEEK_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`
  }

  const date = new Date(timestamp)
  return elapsed < YEAR_MS
    ? monthDayFormatter.format(date)
    : monthDayYearFormatter.format(date)
}

/** The full timestamp, for the `title` attribute behind the relative one. */
export function formatAbsoluteTime(isoTimestamp: string): string {
  const timestamp = Date.parse(isoTimestamp)
  return Number.isNaN(timestamp)
    ? ''
    : absoluteFormatter.format(new Date(timestamp))
}
