import { NodeRuntime } from '@effect/platform-node'

import { runServer } from './server'

NodeRuntime.runMain(runServer)
