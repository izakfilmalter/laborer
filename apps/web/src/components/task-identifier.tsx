import { formatTaskIdentifier } from '@laborer/task-db/task-identifier'
import { Badge } from '@/components/ui/badge'

export function TaskIdentifier({
  projectId,
  projectShortName,
  taskNumber,
}: {
  readonly projectId: string
  readonly projectShortName?: string | null | undefined
  readonly taskNumber: number
}) {
  if (
    !Number.isSafeInteger(taskNumber) ||
    taskNumber < 1 ||
    !projectShortName
  ) {
    return null
  }
  const identifier = formatTaskIdentifier(projectShortName, taskNumber)
  return (
    <Badge
      className="shrink-0 font-mono text-[10px] text-muted-foreground"
      data-task-identifier={identifier}
      data-task-project-id={projectId}
      variant="outline"
    >
      {identifier}
    </Badge>
  )
}
