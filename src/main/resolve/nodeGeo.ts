import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import net from 'net'
import path from 'path'
import { getAppConfig } from '../config'
import { getRuntimeConfig } from '../core/factory'
import { mihomoChangeProxy, mihomoProxyProviders } from '../core/mihomoApi'
import { dataDir } from '../utils/dirs'
import { createLogger } from '../utils/logger'
import { httpsGetViaProxy } from '../utils/proxyHttps'
import { atomicWriteFile } from '../utils/safeFile'
import { mainWindow } from '../window'
import { parseIpinfo, parseIpipProvince } from '../../shared/nodeGeo'

// 节点出口位置查询。
//
// 生成内核配置时加几条隐藏的探测通道：一个包含全部节点（include-all）的 select 分组，加一个只监听
// 127.0.0.1 的 mixed 入站，入站用 proxy 字段把所有流量交给这个分组。查询某个节点时，把探测分组切到
// 该节点，再经入站请求 ipinfo.io，得到的就是这个节点的出口 IP。探测分组与用户使用的分组互不相干，
// 不会改变用户当前选中的节点；隐藏分组和入站也不出现在界面和运行时配置里。

const logger = createLogger('NodeGeo')

const PROBE_PREFIX = '__caesar_probe_'
const PROBE_CHANNELS = 4
const CACHE_TTL = 24 * 60 * 60 * 1000
// 查询失败（节点不通、被限流）的节点一小时内不再重试，避免反复超时
const FAILURE_RETRY = 60 * 60 * 1000

// 不是代理节点的出站类型
const NON_NODE_TYPES = new Set([
  'Direct',
  'Reject',
  'RejectDrop',
  'Compatible',
  'Pass',
  'Dns',
  'Selector',
  'URLTest',
  'Fallback',
  'LoadBalance',
  'Relay'
])

interface ProbeChannel {
  group: string
  port: number
}

let channels: ProbeChannel[] = []
// 本次运行固定使用的探测端口。改设置时配置会重新生成，但内核只做热更新、不重新加载配置，
// 仍然监听最初的端口；每次换新端口会让查询全部打到没人监听的端口上。
let probePorts: number[] = []
let cache: Record<string, INodeGeo> | undefined
let status: INodeGeoStatus = { running: false, done: 0, total: 0 }
let running: Promise<void> | null = null
let rerunRequested = false
let rerunForce = false
let scheduleTimer: NodeJS.Timeout | null = null
let notifyTimer: NodeJS.Timeout | null = null

// 连不上本机的探测端口：是 Clash Caesar 和内核之间的问题，不能记成节点查询失败
export function isChannelDown(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return code === 'ECONNREFUSED' || /ECONNREFUSED 127\.0\.0\.1:/.test(message)
}

export function isProbeGroupName(name: string): boolean {
  return name.startsWith(PROBE_PREFIX)
}

function cachePath(): string {
  return path.join(dataDir(), 'node-geo.json')
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No free port'))))
    })
  })
}

// 给即将交给内核的配置加上探测通道。只用于内核实际加载的配置：运行时配置预览、Gist 同步、
// 订阅校验都不经过这里。
export async function addNodeGeoProbes(profile: IMihomoConfig): Promise<void> {
  const { nodeGeoEnabled = true } = await getAppConfig()
  if (!nodeGeoEnabled) {
    channels = []
    return
  }
  if (probePorts.length !== PROBE_CHANNELS) {
    probePorts = await Promise.all(Array.from({ length: PROBE_CHANNELS }, getFreePort))
  }
  const next = probePorts.map((port, i) => ({ group: `${PROBE_PREFIX}${i}`, port }))
  const doc = profile as unknown as Record<string, unknown>
  const groups = Array.isArray(doc['proxy-groups']) ? (doc['proxy-groups'] as unknown[]) : []
  const listeners = Array.isArray(doc.listeners) ? (doc.listeners as unknown[]) : []
  doc['proxy-groups'] = [
    ...groups,
    ...next.map(({ group }) => ({ name: group, type: 'select', 'include-all': true, hidden: true }))
  ]
  doc.listeners = [
    ...listeners,
    ...next.map(({ group, port }) => ({
      name: group,
      type: 'mixed',
      listen: '127.0.0.1',
      port,
      udp: false,
      proxy: group
    }))
  ]
  channels = next
}

async function lookupExit(port: number, token: string): Promise<Omit<INodeGeo, 'server'>> {
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  const res = await httpsGetViaProxy(port, 'ipinfo.io', `/json${query}`)
  if (res.status === 429) throw new Error('ipinfo rate limited')
  if (res.status !== 200) throw new Error(`ipinfo HTTP ${res.status}`)
  const info = parseIpinfo(JSON.parse(res.body))
  let region: string | undefined
  if (info.country === 'CN') {
    // 只有中国大陆的出口精确到省份
    try {
      const ipip = await httpsGetViaProxy(port, 'myip.ipip.net', '/')
      if (ipip.status === 200) region = parseIpipProvince(ipip.body)
    } catch (e) {
      logger.warn(`ipip lookup failed on probe port ${port}`, e)
    }
  }
  return { ...info, region, updated: Date.now() }
}

// ---- 缓存 ----

// 缓存格式版本：查询方式修正后升版本，丢弃旧版本里因查询方式本身出错而记下的失败结果
const CACHE_VERSION = 2

async function loadCache(): Promise<Record<string, INodeGeo>> {
  if (cache) return cache
  cache = {}
  if (existsSync(cachePath())) {
    try {
      const parsed = JSON.parse(await readFile(cachePath(), 'utf-8'))
      if (parsed?.version === CACHE_VERSION && parsed.nodes && typeof parsed.nodes === 'object') {
        cache = parsed.nodes as Record<string, INodeGeo>
        // 丢掉探测通道本身不通时误记的失败（不是节点的问题）
        for (const [name, geo] of Object.entries(cache)) {
          if (geo.error && isChannelDown(geo.error)) delete cache[name]
        }
      }
    } catch (e) {
      logger.warn('Failed to read node geo cache', e)
    }
  }
  return cache
}

async function saveCache(): Promise<void> {
  if (!cache) return
  await atomicWriteFile(cachePath(), JSON.stringify({ version: CACHE_VERSION, nodes: cache }), {
    encoding: 'utf8'
  })
}

export async function getNodeGeo(): Promise<Record<string, INodeGeo>> {
  return { ...(await loadCache()) }
}

export async function getNodeGeoStatus(): Promise<INodeGeoStatus> {
  return status
}

function notifyRenderer(immediate = false): void {
  const send = (): void => {
    notifyTimer = null
    mainWindow?.webContents.send('nodeGeoUpdated', status)
  }
  if (immediate) {
    if (notifyTimer) clearTimeout(notifyTimer)
    send()
  } else if (!notifyTimer) {
    notifyTimer = setTimeout(send, 500)
  }
}

export function isGeoFresh(geo: INodeGeo | undefined, server: string, now: number): boolean {
  if (!geo || geo.server !== server) return false
  return now - geo.updated < (geo.error ? FAILURE_RETRY : CACHE_TTL)
}

// ---- 查询流程 ----

async function listNodes(): Promise<{ name: string; server: string }[]> {
  const servers = new Map<string, string>()
  const runtimeProxies = ((await getRuntimeConfig())?.proxies ?? []) as unknown[]
  for (const proxy of runtimeProxies) {
    const p = proxy as Record<string, unknown>
    if (typeof p?.name === 'string') servers.set(p.name, `${p.server ?? ''}:${p.port ?? ''}`)
  }
  // "default" 提供者里是配置文件中的节点，其余提供者是 proxy-providers 的节点
  const { providers } = await mihomoProxyProviders()
  const names = new Set<string>()
  for (const provider of Object.values(providers)) {
    for (const proxy of provider.proxies ?? []) {
      if (!NON_NODE_TYPES.has(proxy.type) && !isProbeGroupName(proxy.name)) names.add(proxy.name)
    }
  }
  return [...names].map((name) => ({ name, server: servers.get(name) ?? '' }))
}

async function probe(force: boolean): Promise<void> {
  const active = [...channels]
  if (active.length === 0) return
  const { ipinfoToken = '' } = await getAppConfig()
  const geo = await loadCache()
  const now = Date.now()
  const nodes = await listNodes()
  const todo = nodes.filter((node) => force || !isGeoFresh(geo[node.name], node.server, now))
  status = { running: true, done: 0, total: todo.length }
  notifyRenderer(true)
  if (todo.length === 0) return

  let next = 0
  let channelDown = false
  const worker = async (channel: ProbeChannel): Promise<void> => {
    while (next < todo.length && !channelDown) {
      const node = todo[next++]
      try {
        await mihomoChangeProxy(channel.group, node.name)
      } catch (e) {
        // 内核里没有这个探测分组（还没加载带探测通道的配置），同样不是节点的问题
        channelDown = true
        logger.warn(`Probe group ${channel.group} is not available, stopping this run`, e)
        break
      }
      try {
        geo[node.name] = { server: node.server, ...(await lookupExit(channel.port, ipinfoToken)) }
      } catch (e) {
        if (isChannelDown(e)) {
          // 内核没在这个端口上监听：停下这一轮，不把节点记成失败，内核下次加载配置后再查
          channelDown = true
          logger.warn(`Probe port ${channel.port} is not listening, stopping this run`, e)
          break
        }
        // 查不到就是位置未知，不沿用上次的结果，否则连不上的节点还挂在旧国家下
        geo[node.name] = {
          server: node.server,
          country: '',
          updated: Date.now(),
          error: e instanceof Error ? e.message : String(e)
        }
      }
      status = { ...status, done: status.done + 1 }
      notifyRenderer()
    }
  }
  await Promise.all(active.map(worker))
  await saveCache()
}

async function runLoop(force: boolean): Promise<void> {
  let nextForce = force
  do {
    rerunRequested = false
    rerunForce = false
    try {
      await probe(nextForce)
    } catch (e) {
      logger.warn('Node geo probe failed', e)
    }
    nextForce = rerunForce
  } while (rerunRequested)
  status = { ...status, running: false }
  notifyRenderer(true)
}

// 开始查询；正在查询时排到这一轮之后再跑一次（例如这一轮期间订阅更新了）
export function refreshNodeGeo(force = false): Promise<void> {
  if (running) {
    rerunRequested = true
    rerunForce ||= force
    return running
  }
  running = runLoop(force).finally(() => {
    running = null
  })
  return running
}

// 内核启动、热重载、订阅更新后调用：稍等内核把节点和提供者加载完再查
export function scheduleNodeGeoProbe(delay = 5000): void {
  if (scheduleTimer) clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null
    void refreshNodeGeo()
  }, delay)
}
