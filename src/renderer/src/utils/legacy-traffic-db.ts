import {
  TRAFFIC_USAGE_AGGREGATION_LIMIT,
  TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE,
  TRAFFIC_USAGE_RESOLUTIONS,
  TRAFFIC_USAGE_RESULT_LIMIT,
  TRAFFIC_USAGE_RETENTION,
  trafficUsageRecordKey,
  trafficUsageResolution,
  type TrafficUsageAggregate,
  type TrafficUsageBreakdownQuery,
  type TrafficUsageDimension,
  type TrafficUsageImportBatch,
  type TrafficUsageOverview,
  type TrafficUsageRecord,
  type TrafficUsageSample
} from '../../../shared/trafficUsage'

const DB_NAME = 'clashparty_db'
const DB_VERSION = 2
const LEGACY_STORE = 'data_usage_logs'
const USAGE_STORE = 'traffic_usage_rollups'
const META_STORE = 'traffic_usage_meta'
const RESOLUTION_BUCKET_INDEX = 'resolution_bucket'
const MIGRATION_KEY = 'legacy_migration'
const BACKEND_MIGRATION_KEY = 'backend_migration'

interface LegacyDataUsageLog {
  id: number
  timestamp: number
  sourceIP: string
  host: string
  outbound: string
  process: string
  upload: number
  download: number
}

interface MigrationState {
  key: typeof MIGRATION_KEY
  lastId: number
  complete: boolean
}

interface BackendMigrationState {
  key: typeof BACKEND_MIGRATION_KEY
  migrationId: string
  lastKey?: IDBValidKey
  sequence: number
  complete: boolean
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function mergeRecord(map: Map<string, TrafficUsageRecord>, record: TrafficUsageRecord): void {
  const key = trafficUsageRecordKey(record)
  const current = map.get(key)
  if (current) {
    current.upload += record.upload
    current.download += record.download
    current.count += record.count
  } else {
    map.set(key, record)
  }
}

function legacyRecords(log: LegacyDataUsageLog): TrafficUsageRecord[] {
  return TRAFFIC_USAGE_RESOLUTIONS.map((resolution) => ({
    resolution,
    bucket: Math.floor(log.timestamp / resolution) * resolution,
    sourceIP: log.sourceIP,
    host: log.host,
    outbound: log.outbound,
    process: log.process,
    upload: log.upload,
    download: log.download,
    count: 1
  }))
}

function putAggregatedRecord(store: IDBObjectStore, record: TrafficUsageRecord): void {
  const request = store.get([
    record.resolution,
    record.bucket,
    record.sourceIP,
    record.host,
    record.outbound,
    record.process
  ])
  request.onsuccess = () => {
    const current = request.result as TrafficUsageRecord | undefined
    store.put(
      current
        ? {
            ...current,
            upload: current.upload + record.upload,
            download: current.download + record.download,
            count: current.count + record.count
          }
        : record
    )
  }
}

function putAggregatedRecords(store: IDBObjectStore, records: TrafficUsageRecord[]): void {
  for (const record of records) putAggregatedRecord(store, record)
}

function putAggregatedSamples(store: IDBObjectStore, samples: TrafficUsageSample[]): void {
  for (const sample of samples) {
    for (const resolution of TRAFFIC_USAGE_RESOLUTIONS) {
      putAggregatedRecord(store, {
        ...sample,
        resolution,
        bucket: Math.floor(sample.bucket / resolution) * resolution
      })
    }
  }
}

function dimensionValue(record: TrafficUsageRecord, dimension: TrafficUsageDimension): string {
  return record[dimension]
}

class LegacyTrafficUsageDatabase {
  private database: IDBDatabase | null = null
  private migrationPromise: Promise<void> | null = null
  private backendMigrationPromise: Promise<void> | null = null
  private lastCleanup = 0

  async upsert(samples: TrafficUsageSample[]): Promise<void> {
    if (samples.length === 0) return
    const database = await this.open()
    const transaction = database.transaction([USAGE_STORE, META_STORE], 'readwrite')
    putAggregatedSamples(transaction.objectStore(USAGE_STORE), samples)
    transaction.objectStore(META_STORE).delete(BACKEND_MIGRATION_KEY)
    await transactionComplete(transaction)
    await this.cleanup()
  }

  async overview(
    type: TrafficUsageDimension,
    startTime: number,
    endTime: number,
    bucketSizeMs: number
  ): Promise<TrafficUsageOverview> {
    const rankings = new Map<string, TrafficUsageAggregate>()
    const trend = new Map<number, { upload: number; download: number }>()
    const totals = { upload: 0, download: 0, total: 0, count: 0 }

    await this.iterate(startTime, endTime, (record) => {
      totals.upload += record.upload
      totals.download += record.download
      totals.total += record.upload + record.download
      totals.count += record.count
      this.addAggregate(rankings, dimensionValue(record, type), record)

      const timestamp = Math.floor(record.bucket / bucketSizeMs) * bucketSizeMs
      const bucket = trend.get(timestamp)
      if (bucket) {
        bucket.upload += record.upload
        bucket.download += record.download
      } else {
        trend.set(timestamp, { upload: record.upload, download: record.download })
      }
    })

    return {
      rankings: this.sorted(rankings),
      trend: Array.from(trend, ([timestamp, data]) => ({ timestamp, ...data })).sort(
        (a, b) => a.timestamp - b.timestamp
      ),
      totals
    }
  }

  async breakdown(query: TrafficUsageBreakdownQuery): Promise<TrafficUsageAggregate[]> {
    const aggregates = new Map<string, TrafficUsageAggregate>()
    await this.iterate(query.startTime, query.endTime, (record) => {
      for (const [dimension, value] of Object.entries(query.filters) as [
        TrafficUsageDimension,
        string
      ][]) {
        if (dimensionValue(record, dimension) !== value) return
      }
      this.addAggregate(aggregates, dimensionValue(record, query.groupBy), record)
    })
    return this.sorted(aggregates)
  }

  async clear(): Promise<void> {
    await this.migrationPromise
    await this.backendMigrationPromise
    const database = await this.open()
    const stores = [USAGE_STORE, META_STORE]
    if (database.objectStoreNames.contains(LEGACY_STORE)) stores.push(LEGACY_STORE)
    const transaction = database.transaction(stores, 'readwrite')
    transaction.objectStore(USAGE_STORE).clear()
    if (stores.includes(LEGACY_STORE)) transaction.objectStore(LEGACY_STORE).clear()
    transaction.objectStore(META_STORE).put({
      key: MIGRATION_KEY,
      lastId: 0,
      complete: true
    } satisfies MigrationState)
    transaction.objectStore(META_STORE).delete(BACKEND_MIGRATION_KEY)
    await transactionComplete(transaction)
  }

  migrateLegacyLogs(): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigration().catch((error) => {
        this.migrationPromise = null
        throw error
      })
    }
    return this.migrationPromise
  }

  migrateToBackend(importBatch: (batch: TrafficUsageImportBatch) => Promise<void>): Promise<void> {
    if (!this.backendMigrationPromise) {
      this.backendMigrationPromise = this.runBackendMigration(importBatch).catch((error) => {
        this.backendMigrationPromise = null
        throw error
      })
    }
    return this.backendMigrationPromise
  }

  private async open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(USAGE_STORE)) {
        const store = database.createObjectStore(USAGE_STORE, {
          keyPath: ['resolution', 'bucket', 'sourceIP', 'host', 'outbound', 'process']
        })
        store.createIndex(RESOLUTION_BUCKET_INDEX, ['resolution', 'bucket'])
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    }
    const database = await requestResult(request)
    database.onversionchange = () => database.close()
    this.database = database
    return database
  }

  private async iterate(
    startTime: number,
    endTime: number,
    callback: (record: TrafficUsageRecord) => void
  ): Promise<void> {
    const resolution = trafficUsageResolution(startTime, endTime)
    const database = await this.open()
    const transaction = database.transaction(USAGE_STORE, 'readonly')
    const index = transaction.objectStore(USAGE_STORE).index(RESOLUTION_BUCKET_INDEX)
    const range = IDBKeyRange.bound(
      [resolution, Math.floor(startTime / resolution) * resolution],
      [resolution, Math.floor(endTime / resolution) * resolution]
    )
    const request = index.openCursor(range)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      callback(cursor.value as TrafficUsageRecord)
      cursor.continue()
    }
    request.onerror = () => transaction.abort()
    await transactionComplete(transaction)
  }

  private addAggregate(
    aggregates: Map<string, TrafficUsageAggregate>,
    label: string,
    record: TrafficUsageRecord
  ): void {
    const current = aggregates.get(label)
    if (current) {
      current.upload += record.upload
      current.download += record.download
      current.total += record.upload + record.download
      current.count += record.count
      return
    }
    if (aggregates.size >= TRAFFIC_USAGE_AGGREGATION_LIMIT) return
    aggregates.set(label, {
      label,
      upload: record.upload,
      download: record.download,
      total: record.upload + record.download,
      count: record.count
    })
  }

  private sorted(aggregates: Map<string, TrafficUsageAggregate>): TrafficUsageAggregate[] {
    return Array.from(aggregates.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, TRAFFIC_USAGE_RESULT_LIMIT)
  }

  private async cleanup(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCleanup < 24 * 60 * 60 * 1000) return
    const database = await this.open()
    const transaction = database.transaction(USAGE_STORE, 'readwrite')
    const index = transaction.objectStore(USAGE_STORE).index(RESOLUTION_BUCKET_INDEX)
    for (const resolution of TRAFFIC_USAGE_RESOLUTIONS) {
      const range = IDBKeyRange.bound(
        [resolution, 0],
        [resolution, now - TRAFFIC_USAGE_RETENTION[resolution]],
        false,
        true
      )
      const request = index.openKeyCursor(range)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        transaction.objectStore(USAGE_STORE).delete(cursor.primaryKey)
        cursor.continue()
      }
    }
    await transactionComplete(transaction)
    this.lastCleanup = now
  }

  private async runMigration(): Promise<void> {
    const database = await this.open()
    if (!database.objectStoreNames.contains(LEGACY_STORE)) return

    while (!(await this.migrateChunk())) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  private async migrateChunk(): Promise<boolean> {
    const database = await this.open()
    const transaction = database.transaction([LEGACY_STORE, USAGE_STORE, META_STORE], 'readwrite')
    const legacyStore = transaction.objectStore(LEGACY_STORE)
    const usageStore = transaction.objectStore(USAGE_STORE)
    const metaStore = transaction.objectStore(META_STORE)
    const state = (await requestResult(metaStore.get(MIGRATION_KEY))) as MigrationState | undefined
    if (state?.complete) {
      await transactionComplete(transaction)
      return true
    }

    const aggregates = new Map<string, TrafficUsageRecord>()
    let count = 0
    let lastId = state?.lastId ?? 0
    let complete = false
    const range = lastId > 0 ? IDBKeyRange.lowerBound(lastId, true) : undefined
    const request = legacyStore.openCursor(range)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        complete = true
      } else {
        const log = cursor.value as LegacyDataUsageLog
        lastId = log.id
        for (const record of legacyRecords(log)) mergeRecord(aggregates, record)
        count += 1
      }

      if (cursor && count < TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE) {
        cursor.continue()
        return
      }

      putAggregatedRecords(usageStore, Array.from(aggregates.values()))
      if (aggregates.size > 0) metaStore.delete(BACKEND_MIGRATION_KEY)
      metaStore.put({ key: MIGRATION_KEY, lastId, complete } satisfies MigrationState)
      if (complete) legacyStore.clear()
    }
    request.onerror = () => transaction.abort()
    await transactionComplete(transaction)
    return complete
  }

  private async runBackendMigration(
    importBatch: (batch: TrafficUsageImportBatch) => Promise<void>
  ): Promise<void> {
    await this.runMigration()
    while (!(await this.migrateBackendChunk(importBatch))) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  private async migrateBackendChunk(
    importBatch: (batch: TrafficUsageImportBatch) => Promise<void>
  ): Promise<boolean> {
    const state = await this.backendMigrationState()
    if (state.complete) return true

    const { records, lastKey, complete } = await this.backendMigrationChunk(state.lastKey)
    if (records.length > 0) {
      await importBatch({ id: `${state.migrationId}-${state.sequence}`, records })
    }

    const database = await this.open()
    const transaction = database.transaction([USAGE_STORE, META_STORE], 'readwrite')
    if (complete) transaction.objectStore(USAGE_STORE).clear()
    transaction.objectStore(META_STORE).put({
      key: BACKEND_MIGRATION_KEY,
      migrationId: state.migrationId,
      lastKey,
      sequence: state.sequence + 1,
      complete
    } satisfies BackendMigrationState)
    await transactionComplete(transaction)
    return complete
  }

  private async backendMigrationState(): Promise<BackendMigrationState> {
    const database = await this.open()
    const transaction = database.transaction(META_STORE, 'readonly')
    const state = (await requestResult(
      transaction.objectStore(META_STORE).get(BACKEND_MIGRATION_KEY)
    )) as BackendMigrationState | undefined
    await transactionComplete(transaction)
    if (state) return state

    const initial: BackendMigrationState = {
      key: BACKEND_MIGRATION_KEY,
      migrationId: crypto.randomUUID(),
      sequence: 0,
      complete: false
    }
    const createTransaction = database.transaction(META_STORE, 'readwrite')
    createTransaction.objectStore(META_STORE).put(initial)
    await transactionComplete(createTransaction)
    return initial
  }

  private async backendMigrationChunk(
    lastKey?: IDBValidKey
  ): Promise<{ records: TrafficUsageRecord[]; lastKey?: IDBValidKey; complete: boolean }> {
    const database = await this.open()
    const transaction = database.transaction(USAGE_STORE, 'readonly')
    const store = transaction.objectStore(USAGE_STORE)
    const records: TrafficUsageRecord[] = []
    let nextLastKey = lastKey
    let complete = false
    const request = store.openCursor(
      lastKey === undefined ? undefined : IDBKeyRange.lowerBound(lastKey, true)
    )
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        complete = true
        return
      }
      if (records.length >= TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE) return
      records.push(cursor.value as TrafficUsageRecord)
      nextLastKey = cursor.primaryKey
      cursor.continue()
    }
    request.onerror = () => transaction.abort()
    await transactionComplete(transaction)
    return { records, lastKey: nextLastKey, complete }
  }
}

export const legacyTrafficUsageDatabase = new LegacyTrafficUsageDatabase()
