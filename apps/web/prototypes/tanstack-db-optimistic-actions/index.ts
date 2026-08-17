// THROWAWAY PROTOTYPE for Laborer issue #551. Do not import from production code.
import {
  createCollection,
  createOptimisticAction,
  createPacedMutations,
  queueStrategy,
} from '@tanstack/db'

interface Task {
  id: string
  projectId: string
  revision: number
  title: string
}

interface Project {
  id: string
  name: string
  order: number
  revision: number
}

interface Deferred<T> {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
}

const deferred = <T>(): Deferred<T> => {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

class AuthoritativeTransactions {
  readonly #seen = new Set<string>()
  readonly #waiters = new Map<string, Array<() => void>>()

  awaitTxId(txId: string): Promise<void> {
    if (this.#seen.has(txId)) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const waiters = this.#waiters.get(txId) ?? []
      waiters.push(resolve)
      this.#waiters.set(txId, waiters)
    })
  }

  observe(txId: string): void {
    this.#seen.add(txId)
    for (const resolve of this.#waiters.get(txId) ?? []) {
      resolve()
    }
    this.#waiters.delete(txId)
  }
}

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
}

const print = (label: string, value: unknown): void => {
  console.log(`  ${label}: ${JSON.stringify(value)}`)
}

const taskView = (task: Task | undefined) =>
  task && { title: task.title, revision: task.revision }

const projectView = (projects: Iterable<Project>) =>
  [...projects]
    .sort((left, right) => left.order - right.order)
    .map(({ id, order, revision }) => ({ id, order, revision }))

async function sameRowWaitsForStream(): Promise<void> {
  console.log('\n1. SAME ROW: RPC completion does not retire optimism')

  const rpc = deferred<{ txId: string }>()
  const authoritative = new AuthoritativeTransactions()
  let streamUpdate!: (task: Task) => void
  const tasks = createCollection<Task>({
    id: 'prototype-same-row',
    getKey: (task) => task.id,
    startSync: true,
    sync: {
      sync: (stream) => {
        stream.begin()
        stream.write({
          type: 'insert',
          value: {
            id: 'task-1',
            projectId: 'project-1',
            revision: 1,
            title: 'Old',
          },
        })
        stream.commit()
        stream.markReady()
        streamUpdate = (task) => {
          stream.begin()
          stream.write({ type: 'update', value: task })
          stream.commit()
        }
      },
    },
  })

  const rename = createOptimisticAction<{
    expectedRevision: number
    title: string
  }>({
    onMutate: ({ title }) => {
      tasks.update('task-1', (draft) => {
        draft.title = title
      })
    },
    mutationFn: async () => {
      const response = await rpc.promise
      await authoritative.awaitTxId(response.txId)
    },
  })

  const transaction = rename({ expectedRevision: 1, title: 'Optimistic' })
  print('after synchronous onMutate', taskView(tasks.get('task-1')))
  assert(
    tasks.get('task-1')?.title === 'Optimistic',
    'optimistic title should be immediate'
  )

  rpc.resolve({ txId: 'tx-rename' })
  await tick()
  print('after RPC response, before stream', {
    row: taskView(tasks.get('task-1')),
    transaction: transaction.state,
  })
  assert(
    transaction.state === 'persisting',
    'transaction should await stream confirmation'
  )
  assert(
    tasks.get('task-1')?.title === 'Optimistic',
    'RPC response must not flash back'
  )

  streamUpdate({
    id: 'task-1',
    projectId: 'project-1',
    revision: 2,
    title: 'Authoritative',
  })
  authoritative.observe('tx-rename')
  await transaction.isPersisted.promise
  print('after matching authoritative stream transaction', {
    row: taskView(tasks.get('task-1')),
    transaction: transaction.state,
  })
  assert(
    tasks.get('task-1')?.title === 'Authoritative',
    'stream row should replace optimism'
  )
  console.log(
    '  VERDICT: PASS - mutationFn must await the matching streamed transaction.'
  )
}

async function projectAddIsOptimistic(): Promise<void> {
  console.log('\n2. PROJECT ADD: inserts use the same optimistic contract')

  const rpc = deferred<{ txId: string }>()
  const authoritative = new AuthoritativeTransactions()
  let streamInsert!: (project: Project) => void
  const projects = createCollection<Project>({
    id: 'prototype-project-add',
    getKey: (project) => project.id,
    startSync: true,
    sync: {
      sync: (stream) => {
        stream.begin()
        stream.commit()
        stream.markReady()
        streamInsert = (project) => {
          stream.begin()
          stream.write({ type: 'insert', value: project })
          stream.commit()
        }
      },
    },
  })

  const addProject = createOptimisticAction<Project>({
    onMutate: (project) => {
      projects.insert(project)
    },
    mutationFn: async () => {
      const response = await rpc.promise
      await authoritative.awaitTxId(response.txId)
    },
  })

  const transaction = addProject({
    id: 'project-new',
    name: 'New project',
    order: 0,
    revision: 0,
  })
  print('after synchronous onMutate', projectView(projects.values()))
  assert(projects.has('project-new'), 'project add should be immediate')

  rpc.resolve({ txId: 'tx-project-add' })
  await tick()
  print('after RPC response, before stream', {
    rows: projectView(projects.values()),
    transaction: transaction.state,
  })
  assert(
    transaction.state === 'persisting' && projects.has('project-new'),
    'optimistic project should remain until its stream transaction arrives'
  )

  streamInsert({
    id: 'project-new',
    name: 'New project',
    order: 0,
    revision: 1,
  })
  authoritative.observe('tx-project-add')
  await transaction.isPersisted.promise
  print('after matching authoritative stream transaction', {
    rows: projectView(projects.values()),
    transaction: transaction.state,
  })
  assert(
    projects.get('project-new')?.revision === 1,
    'authoritative project should replace the optimistic insert'
  )
  console.log(
    '  VERDICT: PASS - project add is an optimistic insert, not an exception.'
  )
}

async function overlappingSameRowWrites(): Promise<void> {
  console.log(
    '\n3. OVERLAP: upstream paced mutations queue same-row persistence'
  )

  const authoritative = new AuthoritativeTransactions()
  const rpcA = deferred<{ txId: string }>()
  const rpcB = deferred<{ txId: string }>()
  const rpcCalls: Array<{ expectedRevision: number; title: string }> = []
  let latestAuthoritativeRevision = 1
  let persistenceInFlight = false
  let streamUpdate!: (task: Task) => void
  const tasks = createCollection<Task>({
    id: 'prototype-overlap',
    getKey: (task) => task.id,
    startSync: true,
    sync: {
      sync: (stream) => {
        stream.begin()
        stream.write({
          type: 'insert',
          value: {
            id: 'task-1',
            projectId: 'project-1',
            revision: 1,
            title: 'Old',
          },
        })
        stream.commit()
        stream.markReady()
        streamUpdate = (task) => {
          latestAuthoritativeRevision = task.revision
          stream.begin()
          stream.write({ type: 'update', value: task })
          stream.commit()
        }
      },
    },
  })

  // One stable manager is the upstream queue scope for this row.
  const rename = createPacedMutations<{ title: string }, Task>({
    onMutate: ({ title }) => {
      tasks.update('task-1', (draft) => {
        draft.title = title
      })
    },
    mutationFn: async ({ transaction }) => {
      assert(!persistenceInFlight, 'queued persistence must not overlap')
      persistenceInFlight = true

      const title = transaction.mutations[0].modified.title
      const expectedRevision = latestAuthoritativeRevision
      rpcCalls.push({ expectedRevision, title })
      const response = await (title === 'A' ? rpcA.promise : rpcB.promise)
      await authoritative.awaitTxId(response.txId)

      persistenceInFlight = false
    },
    strategy: queueStrategy({
      addItemsTo: 'back',
      getItemsFrom: 'front',
      wait: 0,
    }),
  })

  const transactionA = rename({ title: 'A' })
  const transactionB = rename({ title: 'B' })
  print('immediately after both calls', {
    row: taskView(tasks.get('task-1')),
    transactionA: transactionA.state,
    transactionB: transactionB.state,
  })
  assert(
    tasks.get('task-1')?.title === 'B',
    'both calls should mutate immediately and newer optimism should win'
  )
  assert(
    transactionA !== transactionB,
    'queue strategy should create one transaction per call'
  )

  await tick()
  print('while A persistence is blocked', rpcCalls)
  assert(
    rpcCalls.length === 1 && rpcCalls[0]?.title === 'A',
    'FIFO queue should start only A persistence'
  )

  rpcA.resolve({ txId: 'tx-a' })
  await tick()
  assert(rpcCalls.length === 1, 'B must wait for A stream confirmation')

  streamUpdate({
    id: 'task-1',
    projectId: 'project-1',
    revision: 7,
    title: 'A',
  })
  authoritative.observe('tx-a')
  await transactionA.isPersisted.promise
  await tick()
  print('after A confirms and B persistence starts', {
    row: taskView(tasks.get('task-1')),
    rpcCalls,
  })
  assert(
    rpcCalls.length === 2 && rpcCalls[1]?.title === 'B',
    'B persistence should start after A confirms'
  )
  assert(
    tasks.get('task-1')?.title === 'B',
    'pending B should remain over confirmed A'
  )
  assert(
    rpcCalls[1]?.expectedRevision === 7,
    'B must read the latest authoritative revision at mutationFn time'
  )

  rpcB.resolve({ txId: 'tx-b' })
  streamUpdate({
    id: 'task-1',
    projectId: 'project-1',
    revision: 11,
    title: 'B',
  })
  authoritative.observe('tx-b')
  await transactionB.isPersisted.promise
  print('after B confirms', {
    row: taskView(tasks.get('task-1')),
    rpcCalls,
  })
  assert(
    tasks.get('task-1')?.title === 'B' && tasks.get('task-1')?.revision === 11,
    'confirmed B should remain visible at the server-assigned revision'
  )
  console.log(
    '  VERDICT: PASS - upstream FIFO queue serializes confirmation and reads authoritative CAS just in time.'
  )
}

async function atomicReorderRollback(): Promise<void> {
  console.log('\n4. REORDER: one optimistic transaction rolls back every row')

  const rejection = deferred<{ txId: string }>()
  const projects = createCollection<Project>({
    id: 'prototype-project-reorder',
    getKey: (project) => project.id,
    startSync: true,
    sync: {
      sync: (stream) => {
        stream.begin()
        for (const project of [
          { id: 'a', name: 'A', order: 0, revision: 1 },
          { id: 'b', name: 'B', order: 1, revision: 1 },
          { id: 'c', name: 'C', order: 2, revision: 1 },
        ]) {
          stream.write({ type: 'insert', value: project })
        }
        stream.commit()
        stream.markReady()
      },
    },
  })

  const reorder = createOptimisticAction<Array<{ id: string; order: number }>>({
    onMutate: (changes) => {
      for (const change of changes) {
        projects.update(change.id, (draft) => {
          draft.order = change.order
        })
      }
    },
    mutationFn: async () => {
      await rejection.promise
    },
  })

  const transaction = reorder([
    { id: 'a', order: 2 },
    { id: 'b', order: 0 },
    { id: 'c', order: 1 },
  ])
  const rejected = transaction.isPersisted.promise.catch(
    (error: unknown) => error
  )
  print('optimistic order', projectView(projects.values()))
  print('TanStack transaction mutation count', transaction.mutations.length)
  assert(
    transaction.mutations.length === 3,
    'all rows should belong to one transaction'
  )
  assert(
    projectView(projects.values())
      .map(({ id }) => id)
      .join('') === 'bca',
    'reorder should be optimistic'
  )

  rejection.reject(new Error('definitive expected_revision rejection'))
  await rejected
  print('after definitive rejection', {
    rows: projectView(projects.values()),
    transaction: transaction.state,
  })
  assert(
    projectView(projects.values())
      .map(({ id }) => id)
      .join('') === 'abc',
    'all rows should roll back'
  )
  assert(transaction.state === 'failed', 'rejected transaction should fail')
  console.log(
    '  VERDICT: PASS - one action gives atomic optimistic apply and rollback.'
  )
}

async function streamBeforeRpc(): Promise<void> {
  console.log('\n5. RACE: stream confirmation arrives before RPC completion')

  const rpc = deferred<{ txId: string }>()
  const authoritative = new AuthoritativeTransactions()
  let streamUpdate!: (task: Task) => void
  const tasks = createCollection<Task>({
    id: 'prototype-stream-first',
    getKey: (task) => task.id,
    startSync: true,
    sync: {
      sync: (stream) => {
        stream.begin()
        stream.write({
          type: 'insert',
          value: {
            id: 'task-1',
            projectId: 'project-1',
            revision: 1,
            title: 'Old',
          },
        })
        stream.commit()
        stream.markReady()
        streamUpdate = (task) => {
          stream.begin()
          stream.write({ type: 'update', value: task })
          stream.commit()
        }
      },
    },
  })

  const rename = createOptimisticAction<string>({
    onMutate: (title) => {
      tasks.update('task-1', (draft) => {
        draft.title = title
      })
    },
    mutationFn: async () => {
      const response = await rpc.promise
      await authoritative.awaitTxId(response.txId)
    },
  })

  const transaction = rename('Optimistic')
  streamUpdate({
    id: 'task-1',
    projectId: 'project-1',
    revision: 2,
    title: 'Authoritative',
  })
  authoritative.observe('tx-stream-first')
  print('stream observed while RPC is pending', {
    row: taskView(tasks.get('task-1')),
    transaction: transaction.state,
  })
  assert(
    tasks.get('task-1')?.title === 'Optimistic',
    'optimism should overlay early stream data'
  )

  rpc.resolve({ txId: 'tx-stream-first' })
  await transaction.isPersisted.promise
  print('after RPC returns already-seen txId', {
    row: taskView(tasks.get('task-1')),
    transaction: transaction.state,
  })
  assert(
    tasks.get('task-1')?.title === 'Authoritative',
    'already-seen confirmation should settle safely'
  )
  console.log(
    '  VERDICT: PASS - retain observed txIds so awaitTxId is level-triggered, not event-only.'
  )
}

console.log('THROWAWAY PROTOTYPE: Laborer #551 with @tanstack/db 0.7.2')
await sameRowWaitsForStream()
await projectAddIsOptimistic()
await overlappingSameRowWrites()
await atomicReorderRollback()
await streamBeforeRpc()
console.log('\nALL SCENARIOS PASSED')
