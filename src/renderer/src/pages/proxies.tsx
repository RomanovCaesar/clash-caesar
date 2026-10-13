import {
  Avatar,
  Button,
  Card,
  CardBody,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  getImageDataURL,
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoProxyDelay
} from '@renderer/utils/ipc'
import { FaLocationCrosshairs } from 'react-icons/fa6'
import { CgDetailsLess, CgDetailsMore } from 'react-icons/cg'
import { TbCircleLetterD } from 'react-icons/tb'
import { RxLetterCaseCapitalize } from 'react-icons/rx'
import {
  MdCheck,
  MdDoubleArrow,
  MdFilterAlt,
  MdMap,
  MdOutlineSpeed,
  MdPublic,
  MdVisibilityOff
} from 'react-icons/md'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { GroupedVirtuoso, GroupedVirtuosoHandle } from 'react-virtuoso'
import ProxyItem from '@renderer/components/proxies/proxy-item'
import { IoIosArrowBack, IoIosArrowDown } from 'react-icons/io'
import { useGroups } from '@renderer/hooks/use-groups'
import CollapseInput from '@renderer/components/base/collapse-input'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useTranslation } from 'react-i18next'
import { HiOutlineAdjustmentsHorizontal } from 'react-icons/hi2'
import NodeMap from '@renderer/components/proxies/node-map'
import { useNodeGeo } from '@renderer/hooks/use-node-geo'
import {
  countryOfRegion,
  isNodeMember,
  regionKeyOf,
  regionLabel,
  UNKNOWN_REGION
} from '@renderer/utils/node-geo'

const GROUP_EXPAND_STATE_KEY = 'proxy_group_expand_state'
const REGION_EXPAND_STATE_KEY = 'proxy_region_expand_state'
// 页面宽度不足时不显示节点地图
const NODE_MAP_MIN_PAGE_WIDTH = 860
// 节点列表占页面宽度的比例（可拖动分隔条调整），默认给地图留出大部分空间
const LIST_RATIO_KEY = 'proxy_list_ratio'
const DEFAULT_LIST_RATIO = 0.2
const MIN_LIST_WIDTH = 260
const MIN_MAP_WIDTH = 320

const loadListRatio = (): number => {
  try {
    const value = Number(localStorage.getItem(LIST_RATIO_KEY))
    return value > 0 && value < 1 ? value : DEFAULT_LIST_RATIO
  } catch {
    return DEFAULT_LIST_RATIO
  }
}

const clampListRatio = (ratio: number, pageWidth: number): number => {
  if (pageWidth <= 0) return ratio
  const min = MIN_LIST_WIDTH / pageWidth
  const max = 1 - MIN_MAP_WIDTH / pageWidth
  return Math.min(Math.max(ratio, min), Math.max(min, max))
}

type ProxyLike = IMihomoProxy | IMihomoGroup

// 分组展开后的每一行：区域标题，或一行节点卡片
type ProxyRow =
  | { kind: 'region'; region: string; count: number; open: boolean; current: boolean }
  | { kind: 'proxies'; items: ProxyLike[] }

type RegionExpandState = Record<string, Record<string, boolean>>

const loadRegionExpandState = (): RegionExpandState => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REGION_EXPAND_STATE_KEY) || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as RegionExpandState) : {}
  } catch {
    return {}
  }
}

const chunk = <T,>(items: T[], size: number): T[][] => {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

// 列数按列表区域的实际宽度计算（地图占用了一部分页面宽度）
const autoColsForWidth = (width: number): number => {
  if (width >= 1290) return 5
  if (width >= 1030) return 4
  if (width >= 770) return 3
  if (width >= 380) return 2
  return 1
}
const EMPTY_GROUPS: IMihomoMixedGroup[] = []

interface GroupExpandState {
  byName: Record<string, boolean>
  legacy?: boolean[]
}

const loadGroupExpandState = (): GroupExpandState => {
  try {
    const savedState = localStorage.getItem(GROUP_EXPAND_STATE_KEY)
    if (!savedState) return { byName: {} }

    const parsed: unknown = JSON.parse(savedState)
    if (Array.isArray(parsed)) {
      return { byName: {}, legacy: parsed.map((isOpen) => isOpen === true) }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const byName: Record<string, boolean> = {}
      Object.entries(parsed).forEach(([name, isOpen]) => {
        if (typeof isOpen === 'boolean') {
          byName[name] = isOpen
        }
      })
      return { byName }
    }
  } catch (error) {
    console.error('Failed to load group expand state:', error)
  }
  return { byName: {} }
}

function getProviderName(proxy: IMihomoProxy | IMihomoGroup): string | undefined {
  return 'provider-name' in proxy ? proxy['provider-name'] : undefined
}

// 自定义 hook 用于管理展开状态
const useProxyState = (
  groups: IMihomoMixedGroup[] | undefined
): {
  virtuosoRef: React.RefObject<GroupedVirtuosoHandle | null>
  isOpen: boolean[]
  setIsOpen: React.Dispatch<React.SetStateAction<boolean[]>>
} => {
  const virtuosoRef = useRef<GroupedVirtuosoHandle | null>(null)
  const [expandState, setExpandState] = useState<GroupExpandState>(loadGroupExpandState)

  const isOpen = useMemo(
    () =>
      groups?.map(
        (group, index) => expandState.byName[group.name] ?? expandState.legacy?.[index] ?? false
      ) ?? [],
    [groups, expandState]
  )

  // 旧数组格式按当前加载的分组顺序迁移一次。
  useEffect(() => {
    if (!groups || expandState.legacy === undefined) return
    setExpandState((prev) => {
      if (prev.legacy === undefined) return prev
      const byName = { ...prev.byName }
      groups.forEach((group, index) => {
        byName[group.name] = prev.legacy?.[index] ?? false
      })
      return { byName }
    })
  }, [groups, expandState.legacy])

  useEffect(() => {
    if (expandState.legacy !== undefined) return
    try {
      localStorage.setItem(GROUP_EXPAND_STATE_KEY, JSON.stringify(expandState.byName))
    } catch (error) {
      console.error('Failed to save group expand state:', error)
    }
  }, [expandState])

  const setIsOpen = useCallback<React.Dispatch<React.SetStateAction<boolean[]>>>(
    (value) => {
      if (!groups) return
      setExpandState((prev) => {
        const current = groups.map(
          (group, index) => prev.byName[group.name] ?? prev.legacy?.[index] ?? false
        )
        const next = typeof value === 'function' ? value(current) : value
        const byName = { ...prev.byName }
        groups.forEach((group, index) => {
          byName[group.name] = next[index] ?? false
        })
        return { byName }
      })
    },
    [groups]
  )

  return {
    virtuosoRef,
    isOpen,
    setIsOpen
  }
}

const Proxies: React.FC = () => {
  const { t, i18n } = useTranslation()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { mode = 'rule' } = controledMihomoConfig || {}
  const { groups: groupData, mutate, showHidden, setShowHidden } = useGroups()
  const groups = groupData ?? EMPTY_GROUPS
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    proxyDisplayMode = 'simple',
    proxyDisplayOrder = 'default',
    autoCloseConnection = true,
    proxyCols = 'auto',
    delayTestConcurrency = 50,
    showNodeMap = true,
    groupProxiesByCountry = true
  } = appConfig || {}
  const { geo, status: geoStatus } = useNodeGeo()
  const [regionOpen, setRegionOpen] = useState<RegionExpandState>(loadRegionExpandState)
  const pageRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pageWidth, setPageWidth] = useState(0)
  const [listRatio, setListRatio] = useState(loadListRatio)
  const [resizing, setResizing] = useState(false)

  const saveListRatio = (ratio: number): void => {
    try {
      localStorage.setItem(LIST_RATIO_KEY, String(ratio))
    } catch {
      // ignore
    }
  }

  // 拖动列表与地图之间的分隔条调整两者宽度
  const onDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const page = pageRef.current
    if (!page) return
    event.preventDefault()
    const rect = page.getBoundingClientRect()
    let latest = listRatio
    setResizing(true)
    const onMove = (e: PointerEvent): void => {
      latest = clampListRatio((e.clientX - rect.left) / rect.width, rect.width)
      setListRatio(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizing(false)
      saveListRatio(latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const [listWidth, setListWidth] = useState(0)
  // 地图点击或定位后待滚动到的行
  const [pendingScroll, setPendingScroll] = useState<{
    group: string
    proxy?: string
    region?: string
  }>()

  useEffect(() => {
    try {
      localStorage.setItem(REGION_EXPAND_STATE_KEY, JSON.stringify(regionOpen))
    } catch {
      // ignore
    }
  }, [regionOpen])

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target === pageRef.current) setPageWidth(entry.contentRect.width)
        if (entry.target === listRef.current) setListWidth(entry.contentRect.width)
      })
    })
    if (pageRef.current) observer.observe(pageRef.current)
    if (listRef.current) observer.observe(listRef.current)
    return (): void => observer.disconnect()
  }, [mode])

  const mapVisible = showNodeMap && pageWidth >= NODE_MAP_MIN_PAGE_WIDTH

  const [cols, setCols] = useState(1)
  const { virtuosoRef, isOpen, setIsOpen } = useProxyState(groupData)
  const [delaying, setDelaying] = useState<Set<string>[]>(() =>
    Array.from({ length: groups.length }, () => new Set<string>())
  )
  const [searchValue, setSearchValue] = useState(Array(groups.length).fill(''))

  // searchValue 初始化
  useEffect(() => {
    if (groups.length !== searchValue.length) {
      setSearchValue(Array(groups.length).fill(''))
    }
  }, [groups.length, searchValue.length])

  useEffect(() => {
    setDelaying((prev) => {
      if (prev.length === groups.length) return prev
      return Array.from({ length: groups.length }, (_, i) => prev[i] ?? new Set<string>())
    })
  }, [groups.length])

  // 代理列表排序
  const sortProxies = useCallback((proxies: (IMihomoProxy | IMihomoGroup)[], order: string) => {
    if (order === 'delay') {
      return [...proxies].sort((a, b) => {
        if (a.history.length === 0) return 1
        if (b.history.length === 0) return -1
        const aDelay = a.history[a.history.length - 1].delay
        const bDelay = b.history[b.history.length - 1].delay
        if (aDelay === 0) return 1
        if (bDelay === 0) return -1
        return aDelay - bDelay
      })
    }
    if (order === 'name') {
      return [...proxies].sort((a, b) => a.name.localeCompare(b.name))
    }
    return proxies
  }, [])

  const { groupCounts, allProxies, groupRows } = useMemo(() => {
    const allProxies: ProxyLike[][] = []

    groups.forEach((group, index) => {
      if (isOpen[index]) {
        const filtered = group.all.filter((proxy) => {
          if (!proxy) return false
          if (!includesIgnoreCase(proxy.name, searchValue[index])) {
            return false
          }
          if (appConfig?.hideUnavailableProxies) {
            const isGroup = 'all' in proxy
            if (isGroup) {
              return true
            }
            if (!proxy.history || proxy.history.length === 0) {
              return true
            }
            const lastDelay = proxy.history[proxy.history.length - 1].delay
            if (lastDelay === 0) {
              return false
            }
          }
          return true
        })
        const sorted = sortProxies(filtered, proxyDisplayOrder)
        allProxies.push(sorted)
      } else {
        allProxies.push([])
      }
    })

    // 每个展开的分组拆成若干行：子分组 / DIRECT 等非节点成员在前；节点按出口区域归类，
    // 每个区域一个可折叠的标题行（区域顺序按列表中首次出现的位置，保留用户选的排序）
    const groupRows: ProxyRow[][] = allProxies.map((proxies, index) => {
      if (!isOpen[index]) return []
      const group = groups[index]
      const members = proxies.filter((p) => !isNodeMember(p))
      const nodes = proxies.filter(isNodeMember)
      const byRegion = new Map<string, ProxyLike[]>()
      nodes.forEach((p) => {
        const key = regionKeyOf(geo[p.name])
        byRegion.set(key, [...(byRegion.get(key) ?? []), p])
      })
      const onlyUnknown = byRegion.size === 1 && byRegion.has(UNKNOWN_REGION)
      if (!groupProxiesByCountry || byRegion.size === 0 || onlyUnknown) {
        return chunk(proxies, cols).map((items) => ({ kind: 'proxies' as const, items }))
      }
      const rows: ProxyRow[] = chunk(members, cols).map((items) => ({
        kind: 'proxies' as const,
        items
      }))
      const regionKeys = [...byRegion.keys()].sort(
        (a, b) => Number(a === UNKNOWN_REGION) - Number(b === UNKNOWN_REGION)
      )
      const searching = Boolean(searchValue[index])
      regionKeys.forEach((region) => {
        const items = byRegion.get(region) ?? []
        const current = items.some((p) => p.name === group.now)
        const open = searching || (regionOpen[group.name]?.[region] ?? current)
        rows.push({ kind: 'region', region, count: items.length, open, current })
        if (open) {
          chunk(items, cols).forEach((row) => rows.push({ kind: 'proxies', items: row }))
        }
      })
      return rows
    })
    const groupCounts = groupRows.map((rows) => rows.length)
    return { groupCounts, allProxies, groupRows }
  }, [
    groups,
    isOpen,
    proxyDisplayOrder,
    cols,
    searchValue,
    sortProxies,
    appConfig?.hideUnavailableProxies,
    geo,
    groupProxiesByCountry,
    regionOpen
  ])

  const onChangeProxy = useCallback(
    async (group: string, proxy: string): Promise<void> => {
      await mihomoChangeProxy(group, proxy)
      if (autoCloseConnection) {
        await mihomoCloseAllConnections()
      }
      mutate()
    },
    [autoCloseConnection, mutate]
  )

  const onProxyDelay = useCallback(
    async (proxy: IMihomoProxy | IMihomoGroup, url?: string): Promise<IMihomoDelay> => {
      return await mihomoProxyDelay(proxy.name, url, getProviderName(proxy))
    },
    []
  )

  // 组测速时逐节点写回会造成 O(N²) 分配与 N 次 allProxies 重算
  const pendingDelayResults = useRef<Map<string, Map<string, { time: string; delay: number }>>>(
    new Map()
  )
  const pendingDelayDone = useRef<Map<number, Set<string>>>(new Map())
  const flushDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushDelayResults = useCallback((): void => {
    if (flushDelayTimer.current) {
      clearTimeout(flushDelayTimer.current)
      flushDelayTimer.current = null
    }
    const results = pendingDelayResults.current
    const done = pendingDelayDone.current
    if (results.size === 0 && done.size === 0) return

    // 把 ref 换成新的空容器，updater 只读这份脱离 ref 的快照
    pendingDelayResults.current = new Map()
    pendingDelayDone.current = new Map()

    if (results.size > 0) {
      mutate(
        (current) => {
          if (!current) return current
          let changed = false
          const next = current.map((group) => {
            const groupResults = results.get(group.name)
            if (!groupResults || groupResults.size === 0) return group
            let groupChanged = false
            const all = group.all.map((p) => {
              const entry = groupResults.get(p.name)
              if (!entry) return p
              groupChanged = true
              return { ...p, history: [...p.history, entry] }
            })
            if (!groupChanged) return group
            changed = true
            return { ...group, all }
          })
          return changed ? next : current
        },
        { revalidate: false }
      )
    }

    if (done.size > 0) {
      setDelaying((prev) => {
        let changed = false
        const next = [...prev]
        done.forEach((names, idx) => {
          const set = next[idx]
          if (!set) return
          const newSet = new Set(set)
          let localChanged = false
          names.forEach((name) => {
            if (newSet.delete(name)) localChanged = true
          })
          if (localChanged) {
            next[idx] = newSet
            changed = true
          }
        })
        return changed ? next : prev
      })
    }
  }, [mutate])

  const scheduleFlushDelayResults = useCallback((): void => {
    if (flushDelayTimer.current) return
    flushDelayTimer.current = setTimeout(flushDelayResults, 200)
  }, [flushDelayResults])

  useEffect(() => {
    return (): void => {
      if (flushDelayTimer.current) {
        clearTimeout(flushDelayTimer.current)
        flushDelayTimer.current = null
      }
    }
  }, [])

  const onGroupDelay = useCallback(
    async (index: number): Promise<void> => {
      if (allProxies[index].length === 0) {
        setIsOpen((prev) => {
          const newOpen = [...prev]
          newOpen[index] = true
          return newOpen
        })
      }
      const proxyNames = allProxies[index].map((p) => p.name)
      setDelaying((prev) => {
        const next = [...prev]
        next[index] = new Set(proxyNames)
        return next
      })

      // 限制并发数量
      const result: Promise<void>[] = []
      const runningList: Promise<void>[] = []
      for (const proxy of allProxies[index]) {
        const promise = Promise.resolve().then(async () => {
          let res: IMihomoDelay | undefined
          try {
            res = await mihomoProxyDelay(proxy.name, groups[index].testUrl, getProviderName(proxy))
          } catch {
            // ignore
          }
          const groupName = groups[index].name
          let groupResults = pendingDelayResults.current.get(groupName)
          if (!groupResults) {
            groupResults = new Map()
            pendingDelayResults.current.set(groupName, groupResults)
          }
          groupResults.set(proxy.name, {
            time: new Date().toISOString(),
            delay: res?.delay ?? 0
          })

          let groupDone = pendingDelayDone.current.get(index)
          if (!groupDone) {
            groupDone = new Set()
            pendingDelayDone.current.set(index, groupDone)
          }
          groupDone.add(proxy.name)

          scheduleFlushDelayResults()
        })
        result.push(promise)
        const running = promise.then(() => {
          runningList.splice(runningList.indexOf(running), 1)
        })
        runningList.push(running)
        if (runningList.length >= (delayTestConcurrency || 50)) {
          await Promise.race(runningList)
        }
      }
      await Promise.all(result)
      flushDelayResults()
    },
    [
      allProxies,
      groups,
      delayTestConcurrency,
      scheduleFlushDelayResults,
      flushDelayResults,
      setIsOpen
    ]
  )

  const calcCols = useCallback((): number => {
    if (proxyCols !== 'auto') {
      return parseInt(proxyCols)
    }
    return autoColsForWidth(listWidth)
  }, [proxyCols, listWidth])

  useEffect(() => {
    const handleResize = (): void => {
      setCols(calcCols())
    }

    handleResize() // 初始化
    window.addEventListener('resize', handleResize)

    return (): void => {
      window.removeEventListener('resize', handleResize)
    }
  }, [calcCols])

  const toggleRegion = useCallback((group: string, region: string, open: boolean): void => {
    setRegionOpen((prev) => ({ ...prev, [group]: { ...prev[group], [region]: open } }))
  }, [])

  // 打开分组和区域后，等行重新计算完再滚动过去
  useEffect(() => {
    if (!pendingScroll) return
    const groupIndex = groups.findIndex((g) => g.name === pendingScroll.group)
    if (groupIndex === -1 || !isOpen[groupIndex]) return
    const rows = groupRows[groupIndex] ?? []
    const rowIndex = rows.findIndex((row) =>
      pendingScroll.proxy
        ? row.kind === 'proxies' && row.items.some((p) => p.name === pendingScroll.proxy)
        : row.kind === 'region' && row.region === pendingScroll.region
    )
    if (rowIndex === -1) return
    const offset = groupCounts.slice(0, groupIndex).reduce((sum, n) => sum + n, 0)
    virtuosoRef.current?.scrollToIndex({ index: offset + rowIndex, align: 'start' })
    setPendingScroll(undefined)
  }, [pendingScroll, groups, isOpen, groupRows, groupCounts, virtuosoRef])

  const revealRegion = useCallback(
    (groupName: string, region: string): void => {
      const index = groups.findIndex((g) => g.name === groupName)
      if (index === -1) return
      setIsOpen((prev) => {
        const next = [...prev]
        next[index] = true
        return next
      })
      toggleRegion(groupName, region, true)
      setPendingScroll({ group: groupName, region })
    },
    [groups, setIsOpen, toggleRegion]
  )

  const renderGroupContent = useCallback(
    (index: number) => {
      if (
        groups[index]?.icon &&
        groups[index].icon.startsWith('http') &&
        !localStorage.getItem(groups[index].icon)
      ) {
        getImageDataURL(groups[index].icon)
          .then((dataURL) => {
            localStorage.setItem(groups[index].icon, dataURL)
            mutate()
          })
          .catch(() => {})
      }
      return groups[index] ? (
        <div
          className={`w-full pt-2 ${index === groupCounts.length - 1 && !isOpen[index] ? 'pb-2' : ''} px-2`}
        >
          <Card
            as="div"
            isPressable
            fullWidth
            onPress={() => {
              setIsOpen((prev) => {
                const newOpen = [...prev]
                newOpen[index] = !prev[index]
                return newOpen
              })
            }}
          >
            <CardBody className="w-full h-14">
              <div className="flex justify-between h-full gap-3">
                <div className="flex min-w-0 h-full text-ellipsis overflow-hidden whitespace-nowrap">
                  {groups[index].icon ? (
                    <Avatar
                      className="bg-transparent mr-2 shrink-0"
                      size="sm"
                      radius="sm"
                      src={
                        groups[index].icon.startsWith('<svg')
                          ? `data:image/svg+xml;utf8,${groups[index].icon}`
                          : localStorage.getItem(groups[index].icon) || groups[index].icon
                      }
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-col h-full">
                    <div className="text-ellipsis overflow-hidden whitespace-nowrap leading-tight text-md flex-5 flex items-center">
                      <span title={groups[index].name} className="flag-emoji inline-block truncate">
                        {groups[index].name}
                      </span>
                    </div>
                    <div className="text-ellipsis overflow-hidden whitespace-nowrap text-[10px] text-foreground-500 leading-tight flex-3 flex items-center">
                      <span>{groups[index].type}</span>
                      <span
                        title={groups[index].now}
                        className="flag-emoji ml-1 inline-block truncate"
                      >
                        {groups[index].now}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <div
                    className="flex items-center"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {proxyDisplayMode === 'full' && (
                      <Chip size="sm" className="my-1 mr-2">
                        {/* 搜索时显示过滤后的节点数，显示总数会让人以为筛选没生效（#332） */}
                        {searchValue[index] && isOpen[index]
                          ? (allProxies[index]?.length ?? 0)
                          : groups[index].all.length}
                      </Chip>
                    )}
                    <CollapseInput
                      title={t('proxies.search.placeholder')}
                      value={searchValue[index]}
                      onValueChange={(v) => {
                        setSearchValue((prev) => {
                          const newSearchValue = [...prev]
                          newSearchValue[index] = v
                          return newSearchValue
                        })
                        // 过滤会改变列表总高度。不把正在筛选的分组标题钉回顶部的话，
                        // 它会被滚出渲染窗口而卸载，搜索框随之消失、焦点丢失，
                        // 中文输入法的组词也被打断（#332、#1621）。
                        virtuosoRef.current?.scrollToIndex({ groupIndex: index, align: 'start' })
                      }}
                    />
                    <Button
                      title={t('proxies.locate')}
                      variant="light"
                      size="sm"
                      isIconOnly
                      onPress={() => {
                        if (!isOpen[index]) {
                          setIsOpen((prev) => {
                            const newOpen = [...prev]
                            newOpen[index] = true
                            return newOpen
                          })
                        }
                        const now = groups[index].now
                        toggleRegion(groups[index].name, regionKeyOf(geo[now]), true)
                        setPendingScroll({ group: groups[index].name, proxy: now })
                      }}
                    >
                      <FaLocationCrosshairs className="text-lg text-foreground-500" />
                    </Button>
                    <Button
                      title={t('proxies.delay.test')}
                      variant="light"
                      isLoading={(delaying[index]?.size ?? 0) > 0}
                      size="sm"
                      isIconOnly
                      onPress={() => {
                        onGroupDelay(index)
                      }}
                    >
                      <MdOutlineSpeed className="text-lg text-foreground-500" />
                    </Button>
                  </div>
                  <IoIosArrowBack
                    className={`transition duration-200 ml-2 h-8 text-lg text-foreground-500 ${isOpen[index] ? '-rotate-90' : ''}`}
                  />
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : (
        <div>Never See This</div>
      )
    },
    [
      groups,
      groupCounts,
      isOpen,
      proxyDisplayMode,
      t,
      searchValue,
      delaying,
      mutate,
      setIsOpen,
      allProxies,
      onGroupDelay,
      toggleRegion,
      geo,
      virtuosoRef
    ]
  )

  const renderItemContent = useCallback(
    (index: number, groupIndex: number) => {
      let innerIndex = index
      groupCounts.slice(0, groupIndex).forEach((count) => {
        innerIndex -= count
      })
      const row = groupRows[groupIndex]?.[innerIndex]
      if (!row) return <div>Never See This</div>
      const isLast =
        groupIndex === groupCounts.length - 1 && innerIndex === groupCounts[groupIndex] - 1
      const group = groups[groupIndex]
      if (row.kind === 'region') {
        return (
          <div className={`px-2 pt-2 ${isLast ? 'pb-2' : ''}`}>
            <button
              className="w-full flex items-center gap-2 rounded-lg px-3 h-9 text-left hover:bg-default-100 transition-colors"
              onClick={() => toggleRegion(group.name, row.region, !row.open)}
            >
              {row.region === UNKNOWN_REGION ? (
                <MdPublic className="text-lg text-foreground-400" />
              ) : (
                <span className={`fi fi-${countryOfRegion(row.region).toLowerCase()} rounded-sm`} />
              )}
              <span className="font-semibold text-sm">
                {regionLabel(row.region, i18n.language, t('proxies.map.unknownRegion'))}
              </span>
              <span className="text-xs text-foreground-400">{row.count}</span>
              {row.current && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
              <IoIosArrowDown
                className={`ml-auto text-foreground-400 transition-transform ${row.open ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        )
      }
      return (
        <div
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          className={`grid ${isLast ? 'pb-2' : ''} gap-2 pt-2 mx-2`}
        >
          {row.items.map((proxy) => (
            <ProxyItem
              key={proxy.name}
              mutateProxies={mutate}
              onProxyDelay={onProxyDelay}
              onSelect={onChangeProxy}
              proxy={proxy}
              group={group}
              proxyDisplayMode={proxyDisplayMode}
              selected={proxy.name === group.now}
              isGroupTesting={delaying[groupIndex]?.has(proxy.name) ?? false}
            />
          ))}
        </div>
      )
    },
    [
      groupCounts,
      groupRows,
      cols,
      groups,
      proxyDisplayMode,
      delaying,
      mutate,
      onProxyDelay,
      onChangeProxy,
      toggleRegion,
      i18n.language,
      t
    ]
  )

  return (
    <BasePage
      title={t('proxies.title')}
      header={
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button
              size="sm"
              isIconOnly
              variant="light"
              className="app-nodrag"
              title={t('proxies.settings')}
            >
              <HiOutlineAdjustmentsHorizontal className="text-lg" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('proxies.settings')}
            className="min-w-64 p-1"
            onAction={(key) => {
              switch (key) {
                case 'show-hidden':
                  setShowHidden((prev) => !prev)
                  break
                case 'hide-unavailable':
                  void patchAppConfig({
                    hideUnavailableProxies: !appConfig?.hideUnavailableProxies
                  })
                  break
                case 'order-default':
                  void patchAppConfig({ proxyDisplayOrder: 'default' })
                  break
                case 'order-delay':
                  void patchAppConfig({ proxyDisplayOrder: 'delay' })
                  break
                case 'order-name':
                  void patchAppConfig({ proxyDisplayOrder: 'name' })
                  break
                case 'mode-simple':
                  void patchAppConfig({ proxyDisplayMode: 'simple' })
                  break
                case 'mode-full':
                  void patchAppConfig({ proxyDisplayMode: 'full' })
                  break
                case 'show-map':
                  void patchAppConfig({ showNodeMap: !showNodeMap })
                  break
                case 'group-country':
                  void patchAppConfig({ groupProxiesByCountry: !groupProxiesByCountry })
                  break
              }
            }}
          >
            <DropdownSection title={t('proxies.settings.visibility')} showDivider>
              <DropdownItem
                key="show-hidden"
                startContent={<MdFilterAlt className="text-lg" />}
                endContent={showHidden ? <MdCheck className="text-lg text-primary" /> : null}
              >
                {t(showHidden ? 'proxies.hiddenGroups.hide' : 'proxies.hiddenGroups.show')}
              </DropdownItem>
              <DropdownItem
                key="hide-unavailable"
                startContent={<MdVisibilityOff className="text-lg" />}
                endContent={
                  appConfig?.hideUnavailableProxies ? (
                    <MdCheck className="text-lg text-primary" />
                  ) : null
                }
              >
                {t(
                  appConfig?.hideUnavailableProxies
                    ? 'proxies.hideUnavailable.enabled'
                    : 'proxies.hideUnavailable.disabled'
                )}
              </DropdownItem>
            </DropdownSection>
            <DropdownSection title={t('proxies.settings.order')} showDivider>
              <DropdownItem
                key="order-default"
                startContent={<TbCircleLetterD className="text-lg" />}
                endContent={
                  proxyDisplayOrder === 'default' ? (
                    <MdCheck className="text-lg text-primary" />
                  ) : null
                }
              >
                {t('proxies.order.default')}
              </DropdownItem>
              <DropdownItem
                key="order-delay"
                startContent={<MdOutlineSpeed className="text-lg" />}
                endContent={
                  proxyDisplayOrder === 'delay' ? (
                    <MdCheck className="text-lg text-primary" />
                  ) : null
                }
              >
                {t('proxies.order.delay')}
              </DropdownItem>
              <DropdownItem
                key="order-name"
                startContent={<RxLetterCaseCapitalize className="text-lg" />}
                endContent={
                  proxyDisplayOrder === 'name' ? <MdCheck className="text-lg text-primary" /> : null
                }
              >
                {t('proxies.order.name')}
              </DropdownItem>
            </DropdownSection>
            <DropdownSection title={t('proxies.settings.map')} showDivider>
              <DropdownItem
                key="show-map"
                startContent={<MdMap className="text-lg" />}
                endContent={showNodeMap ? <MdCheck className="text-lg text-primary" /> : null}
              >
                {t('proxies.map.show')}
              </DropdownItem>
              <DropdownItem
                key="group-country"
                startContent={<MdPublic className="text-lg" />}
                endContent={
                  groupProxiesByCountry ? <MdCheck className="text-lg text-primary" /> : null
                }
              >
                {t('proxies.map.groupByCountry')}
              </DropdownItem>
            </DropdownSection>
            <DropdownSection title={t('proxies.settings.mode')}>
              <DropdownItem
                key="mode-simple"
                startContent={<CgDetailsLess className="text-lg" />}
                endContent={
                  proxyDisplayMode === 'simple' ? (
                    <MdCheck className="text-lg text-primary" />
                  ) : null
                }
              >
                {t('proxies.mode.simple')}
              </DropdownItem>
              <DropdownItem
                key="mode-full"
                startContent={<CgDetailsMore className="text-lg" />}
                endContent={
                  proxyDisplayMode === 'full' ? <MdCheck className="text-lg text-primary" /> : null
                }
              >
                {t('proxies.mode.full')}
              </DropdownItem>
            </DropdownSection>
          </DropdownMenu>
        </Dropdown>
      }
    >
      {mode === 'direct' ? (
        <div className="h-full w-full flex justify-center items-center">
          <div className="flex flex-col items-center">
            <MdDoubleArrow className="text-foreground-500 text-[100px]" />
            <h2 className="text-foreground-500 text-[20px]">{t('proxies.mode.direct')}</h2>
          </div>
        </div>
      ) : (
        <div ref={pageRef} className="h-[calc(100vh-50px)] flex">
          <div
            ref={listRef}
            className={`h-full min-w-0 ${mapVisible ? 'shrink-0' : 'flex-1'}`}
            style={
              mapVisible ? { width: `${clampListRatio(listRatio, pageWidth) * 100}%` } : undefined
            }
          >
            {/* Reset Virtuoso's measured sizes after toggling unavailable proxy filtering. */}
            <GroupedVirtuoso
              key={appConfig?.hideUnavailableProxies ? 'hide-unavailable' : 'show-unavailable'}
              ref={virtuosoRef}
              groupCounts={groupCounts}
              defaultItemHeight={80}
              increaseViewportBy={{ top: 150, bottom: 150 }}
              overscan={200}
              computeItemKey={(index, groupIndex) => `${groupIndex}-${index}`}
              groupContent={renderGroupContent}
              itemContent={renderItemContent}
            />
          </div>
          {mapVisible && (
            <div
              role="separator"
              aria-orientation="vertical"
              title={t('proxies.map.resize')}
              className="group h-full w-2 shrink-0 cursor-col-resize flex justify-center"
              onPointerDown={onDividerPointerDown}
              onDoubleClick={() => {
                setListRatio(DEFAULT_LIST_RATIO)
                saveListRatio(DEFAULT_LIST_RATIO)
              }}
            >
              <div
                className={`h-full w-0.5 rounded-full transition-colors ${resizing ? 'bg-primary' : 'bg-default-200 group-hover:bg-primary/60'}`}
              />
            </div>
          )}
          {mapVisible && (
            <div
              className={`h-full flex-1 min-w-0 ${resizing ? 'pointer-events-none select-none' : ''}`}
            >
              <NodeMap
                groups={groups}
                geo={geo}
                status={geoStatus}
                onSelect={onChangeProxy}
                onRevealRegion={revealRegion}
              />
            </div>
          )}
        </div>
      )}
    </BasePage>
  )
}

export default Proxies
