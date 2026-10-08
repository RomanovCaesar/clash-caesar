import {
  clearTrafficUsage,
  queryTrafficUsageBreakdown,
  queryTrafficUsageOverview
} from '@renderer/utils/ipc'
import { legacyTrafficUsageDatabase } from '@renderer/utils/legacy-traffic-db'
import type {
  TrafficUsageAggregate,
  TrafficUsageBreakdownQuery,
  TrafficUsageDimension,
  TrafficUsageOverview,
  TrafficUsageTrendPoint
} from '../../../shared/trafficUsage'

export type DataUsageType = TrafficUsageDimension
export type AggregatedData = TrafficUsageAggregate

function fillTrend(
  trend: TrafficUsageTrendPoint[],
  startTime: number,
  endTime: number,
  bucketSizeMs: number
): TrafficUsageTrendPoint[] {
  const values = new Map(trend.map((point) => [point.timestamp, point]))
  const result: TrafficUsageTrendPoint[] = []
  const first = Math.floor(startTime / bucketSizeMs) * bucketSizeMs
  const last = Math.floor(endTime / bucketSizeMs) * bucketSizeMs
  for (let timestamp = first; timestamp <= last; timestamp += bucketSizeMs) {
    result.push(values.get(timestamp) ?? { timestamp, upload: 0, download: 0 })
  }
  return result
}

async function overview(
  type: DataUsageType,
  startTime: number,
  endTime: number,
  bucketSizeMs: number
): Promise<TrafficUsageOverview> {
  if (__LEGACY_BUILD__) {
    return legacyTrafficUsageDatabase.overview(type, startTime, endTime, bucketSizeMs)
  }
  return queryTrafficUsageOverview(type, startTime, endTime, bucketSizeMs)
}

async function breakdown(query: TrafficUsageBreakdownQuery): Promise<AggregatedData[]> {
  if (__LEGACY_BUILD__) return legacyTrafficUsageDatabase.breakdown(query)
  return queryTrafficUsageBreakdown(query)
}

export async function getTrafficOverview(
  type: DataUsageType,
  startTime: number,
  endTime: number,
  bucketSizeMs: number
): Promise<TrafficUsageOverview> {
  const result = await overview(type, startTime, endTime, bucketSizeMs)
  return {
    ...result,
    trend: fillTrend(result.trend, startTime, endTime, bucketSizeMs)
  }
}

export function getSubStatsByHost(
  dimension: Exclude<DataUsageType, 'host'>,
  label: string,
  startTime: number,
  endTime: number
): Promise<AggregatedData[]> {
  return breakdown({ groupBy: 'host', filters: { [dimension]: label }, startTime, endTime })
}

export function getDevicesByHost(
  host: string,
  startTime: number,
  endTime: number
): Promise<AggregatedData[]> {
  return breakdown({ groupBy: 'sourceIP', filters: { host }, startTime, endTime })
}

export function getProxyStatsByHost(
  dimension: DataUsageType,
  parentLabel: string,
  host: string,
  startTime: number,
  endTime: number
): Promise<AggregatedData[]> {
  const filters =
    dimension === 'host'
      ? { host: parentLabel, sourceIP: host }
      : { [dimension]: parentLabel, host }
  return breakdown({
    groupBy: 'outbound',
    filters,
    startTime,
    endTime
  })
}

export async function clearTrafficUsageData(): Promise<void> {
  await legacyTrafficUsageDatabase.clear()
  if (!__LEGACY_BUILD__) await clearTrafficUsage()
}
