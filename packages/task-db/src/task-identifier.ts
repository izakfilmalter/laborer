const PROJECT_SHORT_NAME_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/
const TASK_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{0,9})-([1-9][0-9]*)$/
const STARTS_WITH_LETTER_PATTERN = /^[A-Z]/

/** Linear-style project key used as the readable half of a task identifier. */
export const normalizeProjectShortName = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, '')
    .slice(0, 10)

export const defaultProjectShortName = (projectName: string): string => {
  const normalized = normalizeProjectShortName(projectName)
  return normalized.length === 0 || !STARTS_WITH_LETTER_PATTERN.test(normalized)
    ? 'TASK'
    : normalized
}

export const isProjectShortName = (value: string): boolean =>
  PROJECT_SHORT_NAME_PATTERN.test(value)

export const formatTaskIdentifier = (
  projectShortName: string,
  taskNumber: number
): string => `${projectShortName}-${String(taskNumber)}`

export interface ParsedTaskIdentifier {
  readonly projectShortName: string
  readonly taskNumber: number
}

export const parseTaskIdentifier = (
  value: string
): ParsedTaskIdentifier | null => {
  const match = TASK_IDENTIFIER_PATTERN.exec(value.trim().toUpperCase())
  if (!match) {
    return null
  }
  const taskNumber = Number(match[2])
  return Number.isSafeInteger(taskNumber)
    ? { projectShortName: match[1] ?? '', taskNumber }
    : null
}
