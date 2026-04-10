import { projectStoreSchema } from '@laborer/contracts/livestore'
import { makeWorker } from '@livestore/adapter-web/worker'

makeWorker({ schema: projectStoreSchema })
