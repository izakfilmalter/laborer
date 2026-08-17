/**
 * THROWAWAY PROTOTYPE — not production code.
 *
 * Question: which collection boundaries and failure/default semantics make the
 * five mission-control local-persistence concerns safe when multiple renderer
 * windows use TanStack DB's official localStorage adapter?
 *
 * Run: bun run --cwd apps/web prototype:tanstack-local-persistence
 */
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
import { z } from 'zod'

interface Preference {
  id: string
  value: number
}

interface StoredLayout {
  id: string
  windowLayout: unknown
}

type StorageListener = (event: StorageEvent) => void

class MemoryStorage implements Storage {
  protected readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class FailingWriteStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException('Prototype quota exhausted', 'QuotaExceededError')
  }
}

class StorageEvents {
  private readonly listeners = new Set<StorageListener>()

  get listenerCount(): number {
    return this.listeners.size
  }

  addEventListener(_type: 'storage', listener: StorageListener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'storage', listener: StorageListener): void {
    this.listeners.delete(listener)
  }

  emit(key: string, storageArea: Storage): void {
    const event = { key, storageArea } as StorageEvent
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

const quietEvents = new StorageEvents()

function preferenceCollection(
  id: string,
  storageKey: string,
  storage: Storage,
  storageEvents: StorageEvents = quietEvents
) {
  return createCollection(
    localStorageCollectionOptions<Preference>({
      id,
      storageKey,
      storage,
      storageEventApi: storageEvents,
      getKey: (row) => row.id,
      schema: z.object({ id: z.string(), value: z.number().finite() }),
    })
  )
}

function start(collection: {
  subscribeChanges: (listener: () => void) => { unsubscribe: () => void }
}): () => void {
  const subscription = collection.subscribeChanges(() => {
    // Subscription exists only to start the collection's lazy sync.
  })
  return () => subscription.unsubscribe()
}

function check(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Prototype check failed: ${message}`)
  }
}

function heading(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

async function collectionBoundaryEvidence(): Promise<void> {
  heading('1. Collection boundaries under stale multi-window snapshots')

  const combinedStorage = new MemoryStorage()
  const firstWindow = preferenceCollection(
    'laborer.local.interface-preferences.v1',
    'laborer:db:interface-preferences:v1',
    combinedStorage
  )
  const secondWindow = preferenceCollection(
    'laborer.local.interface-preferences.v1',
    'laborer:db:interface-preferences:v1',
    combinedStorage
  )
  const stopFirst = start(firstWindow)
  const stopSecond = start(secondWindow)

  await firstWindow.insert({ id: 'sidebar-width', value: 420 }).isPersisted
    .promise
  await secondWindow.insert({ id: 'board-overlay-height', value: 0.7 })
    .isPersisted.promise

  const combinedWire = JSON.parse(
    combinedStorage.getItem('laborer:db:interface-preferences:v1') ?? '{}'
  ) as Record<string, unknown>
  check(
    !('s:sidebar-width' in combinedWire),
    'the stale second renderer should demonstrate whole-snapshot data loss'
  )
  console.log(
    'Combined collection:',
    Object.keys(combinedWire),
    '— the later renderer erased the unrelated sidebar row.'
  )
  stopFirst()
  stopSecond()

  const separateStorage = new MemoryStorage()
  const sidebar = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    separateStorage
  )
  const board = preferenceCollection(
    'laborer.local.board-overlay-height.v1',
    'laborer:db:board-overlay-height:v1',
    separateStorage
  )
  const stopSidebar = start(sidebar)
  const stopBoard = start(board)
  await sidebar.insert({ id: 'current', value: 420 }).isPersisted.promise
  await board.insert({ id: 'current', value: 0.7 }).isPersisted.promise
  check(
    separateStorage.getItem('laborer:db:sidebar-width:v1') !== null &&
      separateStorage.getItem('laborer:db:board-overlay-height:v1') !== null,
    'separate keys should preserve both independently written preferences'
  )
  console.log('Separate collections: both independent writes remain durable.')
  stopSidebar()
  stopBoard()
}

async function eventEvidence(): Promise<void> {
  heading('2. Same-window confirmation and cross-window storage events')
  const storage = new MemoryStorage()
  const events = new StorageEvents()
  const firstWindow = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    storage,
    events
  )
  const secondWindow = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    storage,
    events
  )
  const stopFirst = start(firstWindow)
  const stopSecond = start(secondWindow)

  await firstWindow.insert({ id: 'current', value: 480 }).isPersisted.promise
  check(firstWindow.get('current')?.value === 480, 'writer confirms itself')
  check(secondWindow.get('current') === undefined, 'peer waits for an event')
  events.emit('laborer:db:sidebar-width:v1', storage)
  check(secondWindow.get('current')?.value === 480, 'peer consumes event')
  console.log(
    'Writer updated immediately; peer updated only after a matching storage event.'
  )
  stopFirst()
  stopSecond()
}

function malformedDataEvidence(): void {
  heading('3. Persisted-row schema and corruption defaults')
  const storage = new MemoryStorage()
  storage.setItem(
    'laborer:db:sidebar-width:v1',
    JSON.stringify({
      's:current': {
        versionKey: 'corrupt-but-shaped',
        data: { id: 'current', value: 'not-a-number' },
      },
    })
  )
  const collection = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    storage
  )
  const stop = start(collection)
  check(
    collection.get('current')?.value === 'not-a-number',
    'the Standard Schema should not be applied while loading persisted rows'
  )
  console.log(
    'A shaped but invalid persisted row bypassed the configured Standard Schema.'
  )
  stop()

  storage.setItem('laborer:db:sidebar-width:v1', '{broken json')
  const corruptCollection = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    storage
  )
  const stopCorrupt = start(corruptCollection)
  check(
    corruptCollection.size === 0,
    'malformed wire data should load as empty'
  )
  check(
    storage.getItem('laborer:db:sidebar-width:v1') === '{broken json',
    'default loading should not repair or remove malformed bytes'
  )
  console.log(
    'Malformed JSON loaded as empty and remained untouched in storage.'
  )
  stopCorrupt()
}

function noMigrationAndLayoutIdentityEvidence(): void {
  heading('4. No migration and per-window layout identity')
  const storage = new MemoryStorage()
  storage.setItem('laborer:sidebar-width', '444')
  storage.setItem(
    'laborer:panel-layout:v1:legacy-window',
    JSON.stringify({ windowLayout: { tabs: [] } })
  )
  const collection = createCollection(
    localStorageCollectionOptions<StoredLayout>({
      id: 'laborer.local.panel-layouts.v1',
      storageKey: 'laborer:db:panel-layouts:v1',
      storage,
      storageEventApi: quietEvents,
      getKey: (row) => row.id,
    })
  )
  const stop = start(collection)
  check(collection.size === 0, 'new collection should ignore legacy keys')
  check(
    storage.getItem('laborer:sidebar-width') === '444',
    'legacy scalar kept'
  )
  collection.insert({ id: 'native-window-a', windowLayout: { tabs: [] } })
  collection.insert({ id: 'native-window-b', windowLayout: { tabs: [] } })
  check(collection.size === 2, 'one shared collection can hold per-window rows')
  console.log(
    'Fresh versioned key ignored old values; native window IDs coexist as row keys.'
  )
  stop()
}

async function writeFailureEvidence(): Promise<void> {
  heading('5. Storage write failure')
  const collection = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    new FailingWriteStorage()
  )
  const stop = start(collection)
  const transaction = collection.insert({ id: 'current', value: 400 })
  let rejected = false
  try {
    await transaction.isPersisted.promise
  } catch (error) {
    rejected = true
    console.log(
      'Persistence rejected with:',
      error instanceof Error ? `${error.name}: ${error.message}` : error
    )
  }
  check(rejected, 'quota failure should reject persistence')
  await Promise.resolve()
  console.log('Collection row after rollback:', collection.get('current'))
  stop()
}

function lifecycleEvidence(): void {
  heading('6. Collection cleanup in @tanstack/db 0.7.2')
  const events = new StorageEvents()
  const collection = preferenceCollection(
    'laborer.local.sidebar-width.v1',
    'laborer:db:sidebar-width:v1',
    new MemoryStorage(),
    events
  )
  const stop = start(collection)
  check(events.listenerCount === 1, 'sync should register one storage listener')
  stop()
  collection.cleanup()
  check(
    events.listenerCount === 1,
    '0.7.2 cleanup currently leaves its storage listener registered'
  )
  console.log(
    'Explicit cleanup left one storage listener registered; verify/fix upstream behavior before migration.'
  )
}

async function main(): Promise<void> {
  console.log('\x1b[1mTanStack DB local-persistence contract prototype\x1b[0m')
  console.log(
    '\x1b[2mExecutable against @tanstack/db 0.7.2; all storage is in memory.\x1b[0m'
  )
  await collectionBoundaryEvidence()
  await eventEvidence()
  malformedDataEvidence()
  noMigrationAndLayoutIdentityEvidence()
  await writeFailureEvidence()
  lifecycleEvidence()
  heading('Prototype verdict')
  console.log(
    [
      '• Use five versioned collections: independent writers otherwise lose unrelated rows.',
      '• Panel layouts are rows keyed by native window ID; the other collections are renderer-global.',
      '• Use fresh keys: old Laborer localStorage remains untouched and unread.',
      '• Native matching storage events synchronize peer windows; writers confirm locally.',
      '• Schema validates mutations, not persisted rows; adapter defaults load corruption as empty.',
      '• Storage write failures reject and use normal optimistic rollback semantics.',
      '• Version 0.7.2 leaks storage listeners on cleanup; implementation must verify a fix or patch it.',
    ].join('\n')
  )
}

await main()
process.exit(0)
