import { Effect } from 'effect'
import { runAcpChatDaemon } from './chat-live.ts'

const defaultLaborerRoot = process.env.LABORER_ROOT ?? process.cwd()

await Effect.runPromise(
  runAcpChatDaemon(defaultLaborerRoot).pipe(Effect.scoped)
)
