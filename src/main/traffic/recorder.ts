import { createLogger } from '../utils/logger'
import {
  TRAFFIC_USAGE_FLUSH_THRESHOLD,
  TrafficUsageAccumulator,
  type TrafficUsageSample,
  type TrafficUsageWriteBatch
} from '../../shared/trafficUsage'
import { closeTrafficUsageDatabase, writeTrafficUsage } from './database'

const FLUSH_DELAY_MS = 5000
const recorderLogger = createLogger('TrafficUsage')
const accumulator = new TrafficUsageAccumulator()

let enabled = false
let flushTimer: NodeJS.Timeout | null = null
let inFlight: Promise<void> | null = null
let retryBatch: TrafficUsageWriteBatch | null = null
let batchSequence = 0
let lastDroppedCount = 0
let shuttingDown = false

function clearFlushTimer(): void {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (__LEGACY_BUILD__ || !enabled || shuttingDown || flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTrafficUsage()
  }, delay)
  flushTimer.unref()
}

function nextBatch(samples: TrafficUsageSample[]): TrafficUsageWriteBatch {
  return {
    id: `${process.pid}-${Date.now()}-${batchSequence++}`,
    samples
  }
}

export function setTrafficUsageEnabled(nextEnabled: boolean): void {
  if (__LEGACY_BUILD__ || enabled === nextEnabled) return
  enabled = nextEnabled
  clearFlushTimer()
  accumulator.setEnabled(nextEnabled)
  if (!nextEnabled) retryBatch = null
}

export function recordTrafficUsage(info: IMihomoConnectionsInfo): void {
  if (__LEGACY_BUILD__ || !enabled) return
  const shouldFlush = accumulator.addSnapshot(info)
  if (accumulator.droppedCount !== lastDroppedCount) {
    lastDroppedCount = accumulator.droppedCount
    recorderLogger.warn(
      `Dropped ${lastDroppedCount} traffic usage records after reaching the pending limit`
    )
  }
  if (shouldFlush && !retryBatch) void flushTrafficUsage()
  else if (retryBatch || accumulator.pendingSize > 0) scheduleFlush()
}

export async function flushTrafficUsage(): Promise<void> {
  if (__LEGACY_BUILD__ || !enabled || inFlight) return inFlight ?? Promise.resolve()

  const batch = retryBatch ?? nextBatch(accumulator.takePending())
  if (batch.samples.length === 0) return
  retryBatch = batch
  inFlight = writeTrafficUsage(batch)
    .then(() => {
      if (retryBatch?.id === batch.id) retryBatch = null
    })
    .catch((error) => {
      recorderLogger.warn('Failed to persist traffic usage', error)
    })
    .finally(() => {
      inFlight = null
      if (enabled && (retryBatch || accumulator.pendingSize > 0)) {
        scheduleFlush(
          accumulator.pendingSize >= TRAFFIC_USAGE_FLUSH_THRESHOLD && !retryBatch
            ? 0
            : FLUSH_DELAY_MS
        )
      }
    })
  return inFlight
}

export async function closeTrafficUsage(): Promise<void> {
  if (__LEGACY_BUILD__) return
  shuttingDown = true
  clearFlushTimer()
  if (inFlight) await inFlight
  clearFlushTimer()
  if (enabled && (retryBatch || accumulator.pendingSize > 0)) {
    await flushTrafficUsage()
    if (inFlight) await inFlight
  }
  enabled = false
  accumulator.setEnabled(false)
  await closeTrafficUsageDatabase()
}
