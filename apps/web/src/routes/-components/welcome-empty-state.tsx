import { FolderGit2 } from 'lucide-react'
import { AddProjectForm } from '@/components/add-project-form'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'

/**
 * Welcome empty state shown in the main content area when no projects
 * are registered. Guides the user to add their first project.
 *
 * @see Issue #118: Empty state — no projects
 */
export function WelcomeEmptyState() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2 />
        </EmptyMedia>
        <EmptyTitle>Welcome to Laborer</EmptyTitle>
        <EmptyDescription>
          Add a git repository to get started. Laborer will create isolated
          workspaces for your AI agents to work in parallel.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <AddProjectForm />
      </EmptyContent>
    </Empty>
  )
}
