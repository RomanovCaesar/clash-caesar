import type { Worker } from 'worker_threads'
import type {
  TrafficUsageAggregate,
  TrafficUsageBreakdownQuery,
  TrafficUsageDimension,
  TrafficUsageImportBatch,
  TrafficUsageOverview,
  TrafficUsageWriteBatch
} from '../../shared/trafficUsage'
import { TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE } from '../../shared/trafficUsage'
import { trafficUsageDatabasePath } from '../utils/dirs'
import createTrafficDatabaseWorker from './database-worker?nodeWorker'
import type { TrafficDatabaseRequest, TrafficDatabaseResponse } from './databaseMessages'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeout?: NodeJS.Timeout
}

type TrafficDatabaseRequestWithoutId = TrafficDatabaseRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

class TrafficDatabaseClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private closing = false

  write(batch: TrafficUsageWriteBatch): Promise<void> {
    return this.request({ action: 'write', payload: batch })
  }

  import(batch: TrafficUsageImportBatch): Promise<void> {
    return this.request({ action: 'import', payload: batch })
  }

  overview(
    type: TrafficUsageDimension,
    startTime: number,
    endTime: number,
    bucketSizeMs: number
  ): Promise<TrafficUsageOverview> {
    return this.request(
      {
        action: 'overview',
        payload: { type, startTime, endTime, bucketSizeMs }
      },
      30_000
    )
  }

  breakdown(query: TrafficUsageBreakdownQuery): Promise<TrafficUsageAggregate[]> {
    return this.request({ action: 'breakdown', payload: query }, 30_000)
  }

  clear(): Promise<void> {
    return this.request({ action: 'clear' }, 30_000)
  }

  async close(): Promise<void> {
    if (!this.worker || this.closing) return
    this.closing = true
    try {
      await this.request({ action: 'close' }, 5000)
    } finally {
      this.worker = null
      this.closing = false
    }
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    if (__LEGACY_BUILD__) throw new Error('Traffic database is unavailable in the legacy build')

    const worker = createTrafficDatabaseWorker({
      workerData: { databasePath: trafficUsageDatabasePath() }
    })
    worker.on('message', (response: TrafficDatabaseResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (pending.timeout) clearTimeout(pending.timeout)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response.result)
    })
    worker.on('error', (error) => this.handleWorkerFailure(worker, error))
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      if (code !== 0 && !this.closing)
        this.handleWorkerFailure(
          worker,
          new Error(`Traffic database worker exited with code ${code}`)
        )
      else this.worker = null
    })
    worker.unref()
    this.worker = worker
    return worker
  }

  private request<T>(request: TrafficDatabaseRequestWithoutId, timeoutMs?: number): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject
      }
      if (timeoutMs) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Traffic database request timed out: ${request.action}`))
        }, timeoutMs)
      }
      this.pending.set(id, pending)
      try {
        this.getWorker().postMessage({ ...request, id } as TrafficDatabaseRequest)
      } catch (error) {
        this.pending.delete(id)
        if (pending.timeout) clearTimeout(pending.timeout)
        reject(error)
      }
    })
  }

  private handleWorkerFailure(worker: Worker, reason: unknown): void {
    if (this.worker !== worker) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.worker = null
  }
}

const database = new TrafficDatabaseClient()

export const writeTrafficUsage = (batch: TrafficUsageWriteBatch): Promise<void> =>
  database.write(batch)
export const importTrafficUsage = (batch: TrafficUsageImportBatch): Promise<void> => {
  if (batch.records.length > TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE) {
    throw new Error('Traffic usage migration batch is too large')
  }
  return database.import({ ...batch, id: `indexeddb:${batch.id}` })
}
export const queryTrafficUsageOverview = (
  type: TrafficUsageDimension,
  startTime: number,
  endTime: number,
  bucketSizeMs: number
): Promise<TrafficUsageOverview> => database.overview(type, startTime, endTime, bucketSizeMs)
export const queryTrafficUsageBreakdown = (
  query: TrafficUsageBreakdownQuery
): Promise<TrafficUsageAggregate[]> => database.breakdown(query)
export const clearTrafficUsage = (): Promise<void> => database.clear()
export const closeTrafficUsageDatabase = (): Promise<void> => database.close()
