import type {
  TrafficUsageBreakdownQuery,
  TrafficUsageImportBatch,
  TrafficUsageOverview,
  TrafficUsageWriteBatch
} from '../../shared/trafficUsage'

export type { TrafficUsageImportBatch, TrafficUsageWriteBatch } from '../../shared/trafficUsage'

export type TrafficDatabaseRequest =
  | { id: number; action: 'write'; payload: TrafficUsageWriteBatch }
  | { id: number; action: 'import'; payload: TrafficUsageImportBatch }
  | {
      id: number
      action: 'overview'
      payload: {
        type: TrafficUsageBreakdownQuery['groupBy']
        startTime: number
        endTime: number
        bucketSizeMs: number
      }
    }
  | { id: number; action: 'breakdown'; payload: TrafficUsageBreakdownQuery }
  | { id: number; action: 'clear' }
  | { id: number; action: 'close' }

export interface TrafficDatabaseResponse {
  id: number
  result?: TrafficUsageOverview | TrafficUsageOverview['rankings'] | undefined
  error?: string
}
