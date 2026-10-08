export type TrafficUsageDimension = 'sourceIP' | 'host' | 'outbound' | 'process'

export interface TrafficUsageRecord {
  resolution: number
  bucket: number
  sourceIP: string
  host: string
  outbound: string
  process: string
  upload: number
  download: number
  count: number
}

export type TrafficUsageSample = Omit<TrafficUsageRecord, 'resolution'>

export interface TrafficUsageWriteBatch {
  id: string
  samples: TrafficUsageSample[]
}

export interface TrafficUsageImportBatch {
  id: string
  records: TrafficUsageRecord[]
}

export interface TrafficUsageAggregate {
  label: string
  upload: number
  download: number
  total: number
  count: number
}

export interface TrafficUsageTrendPoint {
  timestamp: number
  upload: number
  download: number
}

export interface TrafficUsageOverview {
  rankings: TrafficUsageAggregate[]
  trend: TrafficUsageTrendPoint[]
  totals: Omit<TrafficUsageAggregate, 'label'>
}

export interface TrafficUsageBreakdownQuery {
  groupBy: TrafficUsageDimension
  filters: Partial<Record<TrafficUsageDimension, string>>
  startTime: number
  endTime: number
}

export const TRAFFIC_USAGE_RESOLUTIONS = [
  5 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000
] as const

export const TRAFFIC_USAGE_RETENTION: Readonly<Record<number, number>> = {
  [TRAFFIC_USAGE_RESOLUTIONS[0]]: 25 * 60 * 60 * 1000,
  [TRAFFIC_USAGE_RESOLUTIONS[1]]: 8 * 24 * 60 * 60 * 1000,
  [TRAFFIC_USAGE_RESOLUTIONS[2]]: 31 * 24 * 60 * 60 * 1000
}

export const TRAFFIC_USAGE_RESULT_LIMIT = 500
export const TRAFFIC_USAGE_AGGREGATION_LIMIT = 10_000
export const TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE = 500
export const TRAFFIC_USAGE_FLUSH_THRESHOLD = Math.ceil(5_000 / TRAFFIC_USAGE_RESOLUTIONS.length)
export const TRAFFIC_USAGE_PENDING_LIMIT = Math.ceil(20_000 / TRAFFIC_USAGE_RESOLUTIONS.length)

interface TrafficSnapshot {
  upload: number
  download: number
  generation: number
}

const TRAFFIC_USAGE_KEY_SEPARATOR = '\u001f'

export function trafficUsageRecordKey(record: TrafficUsageRecord): string {
  return `${record.resolution}${TRAFFIC_USAGE_KEY_SEPARATOR}${record.bucket}${TRAFFIC_USAGE_KEY_SEPARATOR}${record.sourceIP}${TRAFFIC_USAGE_KEY_SEPARATOR}${record.host}${TRAFFIC_USAGE_KEY_SEPARATOR}${record.outbound}${TRAFFIC_USAGE_KEY_SEPARATOR}${record.process}`
}

function trafficUsageSampleKey(sample: TrafficUsageSample): string {
  return `${sample.bucket}${TRAFFIC_USAGE_KEY_SEPARATOR}${sample.sourceIP}${TRAFFIC_USAGE_KEY_SEPARATOR}${sample.host}${TRAFFIC_USAGE_KEY_SEPARATOR}${sample.outbound}${TRAFFIC_USAGE_KEY_SEPARATOR}${sample.process}`
}

export function trafficUsageResolution(startTime: number, endTime: number): number {
  const range = endTime - startTime
  if (range <= TRAFFIC_USAGE_RETENTION[TRAFFIC_USAGE_RESOLUTIONS[0]]) {
    return TRAFFIC_USAGE_RESOLUTIONS[0]
  }
  if (range <= TRAFFIC_USAGE_RETENTION[TRAFFIC_USAGE_RESOLUTIONS[1]]) {
    return TRAFFIC_USAGE_RESOLUTIONS[1]
  }
  return TRAFFIC_USAGE_RESOLUTIONS[2]
}

export class TrafficUsageAccumulator {
  private readonly lastConnections = new Map<string, TrafficSnapshot>()
  private pending = new Map<string, TrafficUsageSample>()
  private lastUploadTotal = 0
  private lastDownloadTotal = 0
  private generation = 0
  private enabledAt = 0
  private enabled = false
  private droppedRecords = 0

  setEnabled(enabled: boolean, now = Date.now()): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.reset()
    if (enabled) this.enabledAt = now
  }

  addSnapshot(info: IMihomoConnectionsInfo, now = Date.now()): boolean {
    if (!this.enabled) return false

    const uploadTotal = info.uploadTotal || 0
    const downloadTotal = info.downloadTotal || 0
    if (uploadTotal < this.lastUploadTotal || downloadTotal < this.lastDownloadTotal) {
      this.lastConnections.clear()
      this.pending.clear()
    }
    this.lastUploadTotal = uploadTotal
    this.lastDownloadTotal = downloadTotal

    const connections = info.connections ?? []
    if (connections.length === 0) {
      this.lastConnections.clear()
      return false
    }

    const generation = ++this.generation
    for (const connection of connections) {
      const currentUpload = connection.upload || 0
      const currentDownload = connection.download || 0
      const previous = this.lastConnections.get(connection.id)
      let upload: number
      let download: number
      if (previous) {
        upload = Math.max(0, currentUpload - previous.upload)
        download = Math.max(0, currentDownload - previous.download)
        previous.upload = currentUpload
        previous.download = currentDownload
        previous.generation = generation
      } else {
        const startedAt = Date.parse(connection.start)
        const includeInitial = Number.isFinite(startedAt) && startedAt >= this.enabledAt
        upload = includeInitial ? currentUpload : 0
        download = includeInitial ? currentDownload : 0
        this.lastConnections.set(connection.id, {
          upload: currentUpload,
          download: currentDownload,
          generation
        })
      }
      if (upload === 0 && download === 0) continue

      const sourceIP = connection.metadata.sourceIP || 'Inner'
      const host = connection.metadata.host || connection.metadata.destinationIP || 'Unknown'
      const outbound = connection.chains?.[0] || 'DIRECT'
      const process = connection.metadata.process || 'Unknown'
      this.addSample({
        bucket: Math.floor(now / TRAFFIC_USAGE_RESOLUTIONS[0]) * TRAFFIC_USAGE_RESOLUTIONS[0],
        sourceIP,
        host,
        outbound,
        process,
        upload,
        download,
        count: 1
      })
    }

    for (const [id, snapshot] of this.lastConnections) {
      if (snapshot.generation !== generation) this.lastConnections.delete(id)
    }
    return this.pending.size >= TRAFFIC_USAGE_FLUSH_THRESHOLD
  }

  takePending(): TrafficUsageSample[] {
    if (this.pending.size === 0) return []
    const records = Array.from(this.pending.values())
    this.pending = new Map()
    return records
  }

  merge(samples: TrafficUsageSample[]): void {
    for (const sample of samples) this.addSample(sample)
  }

  reset(): void {
    this.lastConnections.clear()
    this.pending.clear()
    this.lastUploadTotal = 0
    this.lastDownloadTotal = 0
    this.generation = 0
    this.enabledAt = 0
  }

  get pendingSize(): number {
    return this.pending.size
  }

  get activeConnectionCount(): number {
    return this.lastConnections.size
  }

  get droppedCount(): number {
    return this.droppedRecords
  }

  private addSample(sample: TrafficUsageSample): void {
    const key = trafficUsageSampleKey(sample)
    const current = this.pending.get(key)
    if (current) {
      current.upload += sample.upload
      current.download += sample.download
      current.count += sample.count
      return
    }
    if (this.pending.size >= TRAFFIC_USAGE_PENDING_LIMIT) {
      this.droppedRecords += 1
      return
    }
    this.pending.set(key, { ...sample })
  }
}
