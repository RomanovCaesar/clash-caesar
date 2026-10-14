import { Button, Select, SelectItem, Spinner, Tooltip } from '@heroui/react'
import { geoNaturalEarth1, geoPath, select, zoom, zoomIdentity, type ZoomTransform } from 'd3'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IoEyeOffOutline, IoEyeOutline } from 'react-icons/io5'
import { MdRefresh } from 'react-icons/md'
import worldTopology from 'world-atlas/countries-110m.json'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { refreshNodeGeo } from '@renderer/utils/ipc'
import {
  countryNumericId,
  countryOfRegion,
  isNodeMember,
  isNodeDown,
  regionKeyOfNode,
  regionLabel,
  regionPoint,
  UNKNOWN_REGION
} from '@renderer/utils/node-geo'
import { maskIp } from '../../../../shared/nodeGeo'

interface Props {
  groups: IMihomoMixedGroup[]
  geo: Record<string, INodeGeo>
  status?: INodeGeoStatus
  onSelect: (group: string, proxy: string) => Promise<void>
  // 一个区域有多个节点时，在左边列表展开该区域让用户选择
  onRevealRegion: (group: string, region: string) => void
}

const topology = worldTopology as unknown as Topology<{ countries: GeometryCollection }>
// 南极洲没有节点，去掉后地图能放得更大
const WORLD = (() => {
  const collection = feature(topology, topology.objects.countries) as FeatureCollection<Geometry>
  return {
    ...collection,
    features: collection.features.filter((f) => f.id !== '010')
  } as FeatureCollection<Geometry>
})()

// 选中的分组当前实际使用的节点（选中的是子分组时沿着子分组往下找）
function resolveNow(groups: IMihomoMixedGroup[], group: IMihomoMixedGroup): string {
  let now = group.now
  for (let depth = 0; depth < 8; depth++) {
    const next = groups.find((g) => g.name === now)
    if (!next || next.now === now) break
    now = next.now
  }
  return now
}

const NodeMap: React.FC<Props> = (props) => {
  const { groups, geo, status, onSelect, onRevealRegion } = props
  const { t, i18n } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { nodeMapGroup, hideExitIp = true } = appConfig || {}
  const [revealIp, setRevealIp] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity)

  const selectGroups = useMemo(
    () => groups.filter((g) => g.type === 'Selector' && g.name !== 'GLOBAL'),
    [groups]
  )
  const target = selectGroups.find((g) => g.name === nodeMapGroup) ?? selectGroups[0]

  // 目标分组里的节点按区域归类
  const regions = useMemo(() => {
    const map = new Map<string, string[]>()
    target?.all.forEach((proxy) => {
      if (!isNodeMember(proxy)) return
      const key = regionKeyOfNode(geo, proxy)
      map.set(key, [...(map.get(key) ?? []), proxy.name])
    })
    return map
  }, [target, geo])

  const nowName = target ? resolveNow(groups, target) : ''
  const nowProxy = useMemo(
    () => groups.flatMap((g) => g.all).find((p) => p.name === nowName),
    [groups, nowName]
  )
  // 当前节点连不上时不显示缓存里的旧出口
  const nowDown = isNodeDown(nowProxy)
  const nowGeo = nowDown ? undefined : geo[nowName]
  const nowRegion = nowProxy ? regionKeyOfNode(geo, nowProxy) : UNKNOWN_REGION
  const highlighted = useMemo(() => {
    const ids = new Set<string>()
    regions.forEach((_names, key) => {
      const id = key === UNKNOWN_REGION ? undefined : countryNumericId(countryOfRegion(key))
      if (id) ids.add(id)
    })
    return ids
  }, [regions])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return (): void => observer.disconnect()
  }, [])

  const { projection, path } = useMemo(() => {
    const projection = geoNaturalEarth1().fitSize(
      [Math.max(size.width, 1), Math.max(size.height, 1)],
      WORLD
    )
    return { projection, path: geoPath(projection) }
  }, [size])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .translateExtent([
        [0, 0],
        [size.width, size.height]
      ])
      .on('zoom', (event) => setTransform(event.transform))
    const selection = select(svg)
    selection.call(behavior)
    return (): void => {
      selection.on('.zoom', null)
    }
  }, [size])

  const markers = useMemo(() => {
    const list: { key: string; x: number; y: number; names: string[] }[] = []
    regions.forEach((names, key) => {
      const point = regionPoint(key)
      const projected = point ? projection(point) : null
      if (!projected) return
      const [x, y] = transform.apply(projected)
      list.push({ key, x, y, names })
    })
    // 当前区域最后画，叠在其它标记上面
    return list.sort((a, b) => Number(a.key === nowRegion) - Number(b.key === nowRegion))
  }, [regions, projection, transform, nowRegion])

  const unknownLabel = t('proxies.map.unknownRegion')
  const showIp = nowGeo?.ip ? (hideExitIp && !revealIp ? maskIp(nowGeo.ip) : nowGeo.ip) : ''

  return (
    <div className="h-full flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <Select
          size="sm"
          className="flex-1"
          aria-label={t('proxies.map.group')}
          selectedKeys={target ? new Set([target.name]) : new Set()}
          disallowEmptySelection
          onSelectionChange={(v) => {
            void patchAppConfig({ nodeMapGroup: v.currentKey as string })
          }}
        >
          {selectGroups.map((g) => (
            <SelectItem key={g.name}>{g.name}</SelectItem>
          ))}
        </Select>
        <Tooltip
          content={
            status?.running
              ? t('proxies.map.probing', { done: status.done, total: status.total })
              : t('proxies.map.refresh')
          }
        >
          <Button
            size="sm"
            isIconOnly
            variant="light"
            isDisabled={status?.running}
            onPress={() => void refreshNodeGeo(true)}
          >
            {status?.running ? <Spinner size="sm" /> : <MdRefresh className="text-lg" />}
          </Button>
        </Tooltip>
      </div>

      {target && (
        <div className="rounded-xl bg-content2 px-3 py-2 text-sm">
          <div className="flex items-center gap-2 font-semibold">
            {nowRegion !== UNKNOWN_REGION && (
              <span className={`fi fi-${countryOfRegion(nowRegion).toLowerCase()} rounded-sm`} />
            )}
            <span className="shrink-0">{regionLabel(nowRegion, i18n.language, unknownLabel)}</span>
            <span className="text-foreground-400">»</span>
            <span className="truncate flag-emoji" title={nowName}>
              {nowName}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-foreground-500">
            <span>{t('proxies.map.exitIp')}</span>
            <span className="font-mono text-foreground">{showIp || '—'}</span>
            {showIp && hideExitIp && (
              <button
                className="text-foreground-400 hover:text-foreground"
                onClick={() => setRevealIp((v) => !v)}
              >
                {revealIp ? <IoEyeOutline size={14} /> : <IoEyeOffOutline size={14} />}
              </button>
            )}
            {nowGeo?.org && <span className="truncate">{nowGeo.org}</span>}
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden rounded-xl bg-content2"
      >
        <svg ref={svgRef} width={size.width} height={size.height} className="cursor-grab">
          <g transform={transform.toString()}>
            {WORLD.features.map((f: Feature<Geometry>) => (
              <path
                key={String(f.id)}
                d={path(f) ?? undefined}
                vectorEffect="non-scaling-stroke"
                style={{
                  fill: highlighted.has(String(f.id))
                    ? 'hsl(var(--heroui-primary) / 0.28)'
                    : 'hsl(var(--heroui-default-200))',
                  stroke: 'hsl(var(--heroui-content2))',
                  strokeWidth: 0.6
                }}
              />
            ))}
          </g>
          {markers.map((marker) => {
            const current = marker.key === nowRegion
            const label = regionLabel(marker.key, i18n.language, unknownLabel)
            return (
              <g
                key={marker.key}
                transform={`translate(${marker.x},${marker.y})`}
                className="cursor-pointer"
                onClick={() => {
                  if (!target) return
                  if (marker.names.length === 1) void onSelect(target.name, marker.names[0])
                  else onRevealRegion(target.name, marker.key)
                }}
              >
                <title>{`${label} · ${marker.names.length}`}</title>
                {/* 倒三角标记，尖端落在坐标点上 */}
                <path
                  d="M -6 -11 L 6 -11 L 0 0 Z"
                  style={{
                    fill: current ? 'hsl(var(--heroui-primary))' : 'hsl(var(--heroui-content1))',
                    stroke: current
                      ? 'hsl(var(--heroui-primary-foreground))'
                      : 'hsl(var(--heroui-foreground) / 0.8)',
                    strokeWidth: 1.4
                  }}
                />
                {marker.names.length > 1 && (
                  <text
                    x={8}
                    y={-3}
                    style={{
                      fill: 'hsl(var(--heroui-foreground) / 0.85)',
                      fontSize: 10,
                      fontWeight: 600
                    }}
                  >
                    {marker.names.length}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {status?.running && (
          <div className="absolute left-2 bottom-2 rounded-md bg-content1/80 px-2 py-1 text-xs text-foreground-500">
            {t('proxies.map.probing', { done: status.done, total: status.total })}
          </div>
        )}
        {regions.get(UNKNOWN_REGION)?.length && !status?.running ? (
          <div className="absolute right-2 bottom-2 rounded-md bg-content1/80 px-2 py-1 text-xs text-foreground-500">
            {t('proxies.map.unknownCount', { count: regions.get(UNKNOWN_REGION)?.length })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default NodeMap
