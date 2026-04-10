import { runMain } from '@effect/platform-node/NodeRuntime'

import { runServer } from './server'

runMain(runServer)
