import { parentPort, workerData } from 'worker_threads'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  TRAFFIC_USAGE_RESULT_LIMIT,
  TRAFFIC_USAGE_RETENTION,
  TRAFFIC_USAGE_RESOLUTIONS,
  trafficUsageResolution,
  type TrafficUsageAggregate,
  type TrafficUsageDimension,
  type TrafficUsageOverview,
  type TrafficUsageSample,
  type TrafficUsageTrendPoint
} from '../../shared/trafficUsage'
import type {
  TrafficDatabaseRequest,
  TrafficDatabaseResponse,
  TrafficUsageImportBatch,
  TrafficUsageWriteBatch
} from './databaseMessages'

const port = parentPort
if (!port) throw new Error('Traffic database worker has no parent port')

const databasePath = (workerData as { databasePath: string }).databasePath
const database = new DatabaseSync(databasePath, { timeout: 5000 })

const columns: Record<TrafficUsageDimension, string> = {
  sourceIP: 'source_ip',
  host: 'host',
  outbound: 'outbound',
  process: 'process'
}

function migrateDatabase(): void {
  const version = Number(
    (database.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0
  )
  if (version > 1) throw new Error(`Unsupported traffic database version: ${version}`)
  if (version === 0) {
    database.exec(`
      CREATE TABLE traffic_usage (
        resolution INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        source_ip TEXT NOT NULL,
        host TEXT NOT NULL,
        outbound TEXT NOT NULL,
        process TEXT NOT NULL,
        upload INTEGER NOT NULL,
        download INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        PRIMARY KEY (resolution, bucket, source_ip, host, outbound, process)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE traffic_usage_batches (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID, STRICT;
      PRAGMA user_version = 1;
    `)
  }
}

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = FILE;
  PRAGMA cache_size = -8192;
  PRAGMA journal_size_limit = 8388608;
`)
migrateDatabase()

const upsert = database.prepare(`
  INSERT INTO traffic_usage (
    resolution, bucket, source_ip, host, outbound, process, upload, download, samples
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (resolution, bucket, source_ip, host, outbound, process) DO UPDATE SET
    upload = upload + excluded.upload,
    download = download + excluded.download,
    samples = samples + excluded.samples
`)
const addBatch = database.prepare(
  'INSERT OR IGNORE INTO traffic_usage_batches (id, created_at) VALUES (?, ?)'
)
const cleanupUsage = database.prepare(
  'DELETE FROM traffic_usage WHERE resolution = ? AND bucket < ?'
)
const cleanupBatches = database.prepare(
  "DELETE FROM traffic_usage_batches WHERE created_at < ? AND id NOT LIKE 'indexeddb:%'"
)
const totalsQuery = database.prepare(`
  SELECT SUM(upload) AS upload, SUM(download) AS download, SUM(samples) AS count
  FROM traffic_usage
  WHERE resolution = ? AND bucket BETWEEN ? AND ?
`)
const trendQuery = database.prepare(`
  SELECT CAST(bucket / ? AS INTEGER) * ? AS timestamp,
         SUM(upload) AS upload,
         SUM(download) AS download
  FROM traffic_usage
  WHERE resolution = ? AND bucket BETWEEN ? AND ?
  GROUP BY CAST(bucket / ? AS INTEGER)
  ORDER BY timestamp
`)
const aggregateStatements = new Map<string, StatementSync>()
let lastCleanup = 0

function runTransaction(action: () => void): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    action()
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function writeRecord(record: TrafficUsageSample, resolution: number, bucket: number): void {
  upsert.run(
    resolution,
    bucket,
    record.sourceIP,
    record.host,
    record.outbound,
    record.process,
    record.upload,
    record.download,
    record.count
  )
}

function persistBatch(id: string, write: () => void): void {
  runTransaction(() => {
    const inserted = addBatch.run(id, Date.now())
    if (inserted.changes === 0) return
    write()
  })

  const now = Date.now()
  if (now - lastCleanup < 24 * 60 * 60 * 1000) return
  runTransaction(() => {
    for (const resolution of TRAFFIC_USAGE_RESOLUTIONS) {
      cleanupUsage.run(resolution, now - TRAFFIC_USAGE_RETENTION[resolution])
    }
    cleanupBatches.run(now - 2 * 24 * 60 * 60 * 1000)
  })
  lastCleanup = now
}

function writeBatch(batch: TrafficUsageWriteBatch): void {
  persistBatch(batch.id, () => {
    for (const sample of batch.samples) {
      for (const resolution of TRAFFIC_USAGE_RESOLUTIONS) {
        writeRecord(sample, resolution, Math.floor(sample.bucket / resolution) * resolution)
      }
    }
  })
}

function importBatch(batch: TrafficUsageImportBatch): void {
  persistBatch(batch.id, () => {
    for (const record of batch.records) {
      writeRecord(record, record.resolution, record.bucket)
    }
  })
}

function mapAggregate(row: Record<string, unknown>): TrafficUsageAggregate {
  const upload = Number(row.upload ?? 0)
  const download = Number(row.download ?? 0)
  return {
    label: String(row.label ?? ''),
    upload,
    download,
    total: upload + download,
    count: Number(row.count ?? 0)
  }
}

function aggregateQuery(
  groupBy: TrafficUsageDimension,
  filters: Partial<Record<TrafficUsageDimension, string>>,
  startTime: number,
  endTime: number
): TrafficUsageAggregate[] {
  const resolution = trafficUsageResolution(startTime, endTime)
  const values: (string | number)[] = [
    resolution,
    Math.floor(startTime / resolution) * resolution,
    Math.floor(endTime / resolution) * resolution
  ]
  const clauses = ['resolution = ?', 'bucket BETWEEN ? AND ?']
  for (const [dimension, value] of Object.entries(filters) as [TrafficUsageDimension, string][]) {
    clauses.push(`${columns[dimension]} = ?`)
    values.push(value)
  }
  const column = columns[groupBy]
  const sql = `
    SELECT ${column} AS label,
           SUM(upload) AS upload,
           SUM(download) AS download,
           SUM(samples) AS count
    FROM traffic_usage
    WHERE ${clauses.join(' AND ')}
    GROUP BY ${column}
    ORDER BY SUM(upload) + SUM(download) DESC
    LIMIT ${TRAFFIC_USAGE_RESULT_LIMIT}
  `
  let statement = aggregateStatements.get(sql)
  if (!statement) {
    statement = database.prepare(sql)
    aggregateStatements.set(sql, statement)
  }
  return (statement.all(...values) as Record<string, unknown>[]).map(mapAggregate)
}

function queryOverview(
  payload: Extract<TrafficDatabaseRequest, { action: 'overview' }>['payload']
): TrafficUsageOverview {
  const resolution = trafficUsageResolution(payload.startTime, payload.endTime)
  const start = Math.floor(payload.startTime / resolution) * resolution
  const end = Math.floor(payload.endTime / resolution) * resolution
  const rankings = aggregateQuery(payload.type, {}, payload.startTime, payload.endTime)
  const totalsRow = totalsQuery.get(resolution, start, end) as Record<string, unknown>
  const trend = (
    trendQuery.all(
      payload.bucketSizeMs,
      payload.bucketSizeMs,
      resolution,
      start,
      end,
      payload.bucketSizeMs
    ) as Record<string, unknown>[]
  ).map((row): TrafficUsageTrendPoint => ({
    timestamp: Number(row.timestamp),
    upload: Number(row.upload ?? 0),
    download: Number(row.download ?? 0)
  }))
  const upload = Number(totalsRow.upload ?? 0)
  const download = Number(totalsRow.download ?? 0)
  return {
    rankings,
    trend,
    totals: {
      upload,
      download,
      total: upload + download,
      count: Number(totalsRow.count ?? 0)
    }
  }
}

function handleRequest(request: TrafficDatabaseRequest): TrafficDatabaseResponse['result'] {
  switch (request.action) {
    case 'write':
      writeBatch(request.payload)
      return
    case 'import':
      importBatch(request.payload)
      return
    case 'overview':
      return queryOverview(request.payload)
    case 'breakdown':
      return aggregateQuery(
        request.payload.groupBy,
        request.payload.filters,
        request.payload.startTime,
        request.payload.endTime
      )
    case 'clear':
      runTransaction(() =>
        database.exec('DELETE FROM traffic_usage; DELETE FROM traffic_usage_batches')
      )
      return
    case 'close':
      database.close()
      return
  }
}

port.on('message', (request: TrafficDatabaseRequest) => {
  let response: TrafficDatabaseResponse
  try {
    response = { id: request.id, result: handleRequest(request) }
  } catch (error) {
    response = { id: request.id, error: error instanceof Error ? error.message : String(error) }
  }
  port.postMessage(response)
  if (request.action === 'close') port.close()
})
