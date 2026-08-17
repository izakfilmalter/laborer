import { Effect } from 'effect'
import { ProjectRegistry } from './project-registry.js'

export const registerInitialDevProject = Effect.fn(
  'DevProjectBootstrap.registerInitialProject'
)(function* (repoPath: string) {
  const registry = yield* ProjectRegistry
  const project = yield* registry.addProject(repoPath, false)
  yield* Effect.logInfo(
    `[dev-bootstrap] Registered initial project ${project.repoPath}`
  )
  return project
})
