import { readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { subTemplateConfigPath, subTemplatePath } from '../utils/dirs'
import * as chromeRequest from '../utils/chromeRequest'
import { parse, stringify } from '../utils/yaml'
import { atomicWriteFile } from '../utils/safeFile'
import { defaultSubTemplateConfig } from '../utils/template'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { getControledMihomoConfig } from './controledMihomo'
import { runtimeConfigWriteQueue } from './runtimeConfigQueue'

// 订阅模版：Mihomo 格式的配置骨架（分组 + 分流规则），不含任何节点。生成运行配置时
// 只从订阅里取节点，分组和规则换成模版的；订阅文件本身不做任何修改。
//
// "放节点"的分组用 Mihomo 自己的 include-all-proxies 标记，存下来的模版仍是合法的
// Mihomo 配置。套用时改成 include-all，订阅里 proxy-providers 的节点也一并放进去。

export const SUB_TEMPLATE_BUILTIN_ID = 'builtin'
export const SUB_TEMPLATE_NONE = 'none'
export const SUB_TEMPLATE_VARIANTS: SubTemplateVariant[] = ['cn', 'ru', 'ir']

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024
const MAX_TEMPLATE_NAME_LENGTH = 64

// 模版接管的配置项；关闭"覆盖其它设置"时只替换这几项
const ROUTING_KEYS = ['proxy-groups', 'rules', 'rule-providers', 'sub-rules'] as const
// 永远取自订阅的配置项
const NODE_KEYS = ['proxies', 'proxy-providers'] as const

// 每个 Mihomo 配置都认识、无需声明的策略名，清理时不会被当成节点
const MIHOMO_BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

type MihomoDoc = Record<string, unknown>
type ProxyGroup = Record<string, unknown>

// ---- 内置模版 ----

interface BuiltinVariantSpec {
  proxyGroup: string
  autoGroup: string
  direct: string[]
}

const BUILTIN_VARIANT_SPECS: Record<SubTemplateVariant, BuiltinVariantSpec> = {
  cn: {
    proxyGroup: '节点选择',
    autoGroup: '自动选择',
    direct: [
      // 国内公共 DNS 直连，避免 DNS 查询被代理绕远。
      'IP-CIDR,223.5.5.5/32,DIRECT,no-resolve',
      'IP-CIDR,223.6.6.6/32,DIRECT,no-resolve',
      'IP-CIDR,2400:3200::1/128,DIRECT,no-resolve',
      'IP-CIDR,2400:3200:baba::1/128,DIRECT,no-resolve',
      'IP-CIDR,119.29.29.29/32,DIRECT,no-resolve',
      'IP-CIDR,1.12.12.12/32,DIRECT,no-resolve',
      'IP-CIDR,120.53.53.53/32,DIRECT,no-resolve',
      'IP-CIDR,2402:4e00::/128,DIRECT,no-resolve',
      'IP-CIDR,2402:4e00:1::/128,DIRECT,no-resolve',
      'IP-CIDR,180.76.76.76/32,DIRECT,no-resolve',
      'IP-CIDR,2400:da00::6666/128,DIRECT,no-resolve',
      'IP-CIDR,114.114.114.114/32,DIRECT,no-resolve',
      'IP-CIDR,114.114.115.115/32,DIRECT,no-resolve',
      'IP-CIDR,114.114.114.119/32,DIRECT,no-resolve',
      'IP-CIDR,114.114.115.119/32,DIRECT,no-resolve',
      'IP-CIDR,114.114.114.110/32,DIRECT,no-resolve',
      'IP-CIDR,114.114.115.110/32,DIRECT,no-resolve',
      'IP-CIDR,180.184.1.1/32,DIRECT,no-resolve',
      'IP-CIDR,180.184.2.2/32,DIRECT,no-resolve',
      'IP-CIDR,101.226.4.6/32,DIRECT,no-resolve',
      'IP-CIDR,218.30.118.6/32,DIRECT,no-resolve',
      'IP-CIDR,123.125.81.6/32,DIRECT,no-resolve',
      'IP-CIDR,140.207.198.6/32,DIRECT,no-resolve',
      'IP-CIDR,1.2.4.8/32,DIRECT,no-resolve',
      'IP-CIDR,210.2.4.8/32,DIRECT,no-resolve',
      'IP-CIDR,52.80.66.66/32,DIRECT,no-resolve',
      'IP-CIDR,117.50.22.22/32,DIRECT,no-resolve',
      'IP-CIDR,2400:7fc0:849e:200::4/128,DIRECT,no-resolve',
      'IP-CIDR,2404:c2c0:85d8:901::4/128,DIRECT,no-resolve',
      'IP-CIDR,117.50.10.10/32,DIRECT,no-resolve',
      'IP-CIDR,52.80.52.52/32,DIRECT,no-resolve',
      'IP-CIDR,2400:7fc0:849e:200::8/128,DIRECT,no-resolve',
      'IP-CIDR,2404:c2c0:85d8:901::8/128,DIRECT,no-resolve',
      'IP-CIDR,117.50.60.30/32,DIRECT,no-resolve',
      'IP-CIDR,52.80.60.30/32,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,alidns.com,DIRECT',
      'DOMAIN-SUFFIX,doh.pub,DIRECT',
      'DOMAIN-SUFFIX,dot.pub,DIRECT',
      'DOMAIN-SUFFIX,360.cn,DIRECT',
      'DOMAIN-SUFFIX,onedns.net,DIRECT',
      'GEOIP,cn,DIRECT,no-resolve',
      'GEOSITE,cn,DIRECT'
    ]
  },
  ru: {
    proxyGroup: 'Proxy',
    autoGroup: 'Auto',
    direct: [
      // Yandex DNS.
      'IP-CIDR,77.88.8.8/32,DIRECT,no-resolve',
      'IP-CIDR,77.88.8.1/32,DIRECT,no-resolve',
      'IP-CIDR,2a02:6b8::feed:0ff/128,DIRECT,no-resolve',
      'IP-CIDR,2a02:6b8:0:1::feed:0ff/128,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,dns.yandex,DIRECT',
      'GEOIP,ru,DIRECT,no-resolve',
      'GEOSITE,category-ru,DIRECT'
    ]
  },
  ir: {
    proxyGroup: 'Proxy',
    autoGroup: 'Auto',
    direct: [
      // Shecan DNS.
      'IP-CIDR,178.22.122.100/32,DIRECT,no-resolve',
      'IP-CIDR,185.51.200.2/32,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,shecan.ir,DIRECT',
      'GEOIP,ir,DIRECT,no-resolve',
      'GEOSITE,category-ir,DIRECT'
    ]
  }
}

// 内置模版与 m-ui 的内置订阅模版保持一致：三个地区变体共用基础设置、分组和代理规则，
// 只在哪些流量直连上不同。
export function builtinSubTemplateYAML(variant: SubTemplateVariant): string {
  const spec = BUILTIN_VARIANT_SPECS[variant] ?? BUILTIN_VARIANT_SPECS.cn
  const proxy = spec.proxyGroup
  const rules = [
    'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT',
    `DOMAIN-SUFFIX,browserleaks.com,${proxy}`,
    `DOMAIN-SUFFIX,browserleaks.org,${proxy}`,
    `DOMAIN-SUFFIX,ipleak.net,${proxy}`,
    `DOMAIN-SUFFIX,googleapis.cn,${proxy}`,
    `DOMAIN-SUFFIX,gstatic.com,${proxy}`,
    `GEOSITE,google,${proxy}`,
    `GEOSITE,category-ai-!cn,${proxy}`,
    `GEOSITE,apple,${proxy}`,
    `GEOSITE,tiktok,${proxy}`,
    `GEOSITE,microsoft,${proxy}`,
    'GEOIP,private,DIRECT,no-resolve',
    'GEOSITE,private,DIRECT',
    ...spec.direct,
    `MATCH,${proxy}`
  ]
  const doc = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: true,
    'unified-delay': true,
    'tcp-concurrent': true,
    'external-controller': '127.0.0.1:9090',
    'geodata-mode': true,
    'geo-auto-update': true,
    'geo-update-interval': 24,
    profile: { 'store-selected': true },
    'proxy-groups': [
      {
        name: proxy,
        type: 'select',
        proxies: [spec.autoGroup, 'DIRECT'],
        'include-all-proxies': true
      },
      {
        name: spec.autoGroup,
        type: 'url-test',
        'include-all-proxies': true,
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50
      }
    ],
    rules
  }
  return stringify(doc)
}

// ---- 规则解析 ----

export interface TemplateRule {
  type: string
  value: string
  target: string
  options: string[]
  sub?: TemplateRule[]
}

// 按括号外的逗号切分
function splitRuleTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

function isLogicalRule(type: string): boolean {
  return type === 'AND' || type === 'OR' || type === 'NOT'
}

// 解析 "((TYPE,value),(TYPE,value))"
function parseLogicalPayload(payload: string): TemplateRule[] {
  if (!payload.startsWith('(') || !payload.endsWith(')')) {
    throw new Error('bad logical payload')
  }
  return splitRuleTopLevel(payload.slice(1, -1)).map((item) => {
    if (!item.startsWith('(') || !item.endsWith(')')) throw new Error('bad logical item')
    const parts = splitRuleTopLevel(item.slice(1, -1))
    if (parts.length < 2 || parts[1] === '') throw new Error('bad logical item')
    const sub: TemplateRule = {
      type: parts[0].toUpperCase(),
      value: parts[1],
      target: '',
      options: parts.slice(2)
    }
    if (isLogicalRule(sub.type)) {
      sub.sub = parseLogicalPayload(sub.value)
      sub.value = ''
    }
    return sub
  })
}

export function parseTemplateRule(text: string): TemplateRule {
  const parts = splitRuleTopLevel(text.trim())
  const type = parts[0].toUpperCase()
  if (type === 'MATCH' || type === 'FINAL') {
    if (parts.length < 2 || parts[1] === '') throw new Error(`规则格式无效: ${text}`)
    return { type: 'MATCH', value: '', target: parts[1], options: [] }
  }
  if (parts.length < 3 || parts[1] === '' || parts[2] === '') {
    throw new Error(`规则格式无效: ${text}`)
  }
  const rule: TemplateRule = { type, value: parts[1], target: parts[2], options: parts.slice(3) }
  if (isLogicalRule(type)) {
    try {
      rule.sub = parseLogicalPayload(rule.value)
    } catch {
      throw new Error(`规则格式无效: ${text}`)
    }
    rule.value = ''
  }
  return rule
}

function rulePayload(rule: TemplateRule): string {
  if (!rule.sub) return rule.value
  const items = rule.sub.map((sub) => `(${[sub.type, rulePayload(sub), ...sub.options].join(',')})`)
  return `(${items.join(',')})`
}

export function formatTemplateRule(rule: TemplateRule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.target}`
  return [rule.type, rulePayload(rule), rule.target, ...rule.options].join(',')
}

// ---- 解析与校验 ----

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBuiltinTarget(name: string): boolean {
  return MIHOMO_BUILTIN_TARGETS.includes(name.toUpperCase())
}

function decodeTemplateDocument(content: string): MihomoDoc {
  if (content.trim() === '') throw new Error('模版内容为空')
  if (Buffer.byteLength(content, 'utf8') > MAX_TEMPLATE_BYTES) throw new Error('模版超过 2 MB')
  let doc: unknown
  try {
    doc = parse(content)
  } catch (e) {
    throw new Error(`YAML 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isMapping(doc)) throw new Error('不是 Mihomo 配置：顶层必须是键值映射')
  return doc
}

function isNodeGroup(group: ProxyGroup): boolean {
  return group['include-all-proxies'] === true || group['include-all'] === true
}

// 校验一份已清理的模版：分组完整、引用都能找到、规则都指向存在的分组
function validateTemplateDocument(doc: MihomoDoc): void {
  if (doc.proxies !== undefined || doc['proxy-providers'] !== undefined) {
    throw new Error('模版里不能包含节点')
  }
  const groups = doc['proxy-groups']
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('缺少 proxy-groups 分组')
  const names = new Set<string>()
  for (const group of groups) {
    const name = isMapping(group) && typeof group.name === 'string' ? group.name.trim() : ''
    if (!name || names.has(name)) throw new Error(`分组名缺失或重复: ${name}`)
    if (typeof group.type !== 'string' || group.type === '') {
      throw new Error(`分组缺少 type: ${name}`)
    }
    names.add(name)
  }
  const known = (name: string): boolean => names.has(name) || isBuiltinTarget(name)
  for (const group of groups as ProxyGroup[]) {
    const members = group.proxies
    if (members !== undefined && !Array.isArray(members)) {
      throw new Error(`分组的 proxies 必须是列表: ${group.name}`)
    }
    for (const member of (members as unknown[]) ?? []) {
      if (typeof member !== 'string' || !known(member)) {
        throw new Error(`分组引用了不存在的分组或节点: ${group.name} → ${String(member)}`)
      }
    }
    if ((!Array.isArray(members) || members.length === 0) && !isNodeGroup(group)) {
      throw new Error(`分组是空的: ${group.name}`)
    }
  }
  const rules = doc.rules
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('缺少 rules 规则')
  for (const item of rules) {
    if (typeof item !== 'string') throw new Error('rules 里有不是字符串的规则')
    const rule = parseTemplateRule(item)
    if (rule.type !== 'SUB-RULE' && !known(rule.target)) {
      throw new Error(`规则指向不存在的分组: ${item} → ${rule.target}`)
    }
  }
}

// 解析并校验一份已清理的模版
export function parseSubTemplate(content: string): MihomoDoc {
  const doc = decodeTemplateDocument(content)
  validateTemplateDocument(doc)
  return doc
}

// ---- 导入：去掉节点，留下骨架 ----

// 把一份完整订阅或不含节点的模版清理成可保存的模版：删除 proxies、proxy-providers 和所有
// 注释；原来列了节点（或从 provider 取节点）的分组标记为 include-all-proxies；直接指向某个
// 节点的规则改指向第一个放节点的分组。
export function cleanSubTemplate(content: string): {
  content: string
  stats: ISubTemplateStats
} {
  const stats: ISubTemplateStats = {
    removedProxies: 0,
    removedProviders: 0,
    nodeGroups: 0,
    groups: 0,
    rules: 0,
    retargetedRules: 0
  }
  // 解析后再序列化会自然丢掉注释：每个使用者都会拿到模版，导出的配置里注释常带有来源或节点名
  const doc = decodeTemplateDocument(content)
  const nodeNames = new Set<string>()
  if (Array.isArray(doc.proxies)) {
    for (const proxy of doc.proxies) {
      if (isMapping(proxy) && typeof proxy.name === 'string') nodeNames.add(proxy.name)
    }
    stats.removedProxies = doc.proxies.length
  }
  if (isMapping(doc['proxy-providers'])) {
    stats.removedProviders = Object.keys(doc['proxy-providers']).length
  }
  delete doc.proxies
  delete doc['proxy-providers']

  const groups = doc['proxy-groups']
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('缺少 proxy-groups 分组')
  const groupNames = new Set<string>()
  for (const group of groups) {
    const name = isMapping(group) && typeof group.name === 'string' ? group.name.trim() : ''
    if (!name) throw new Error('proxy-groups 里有缺少 name 的分组')
    if (groupNames.has(name)) throw new Error(`分组名重复: ${name}`)
    groupNames.add(name)
  }
  const keep = (member: unknown): boolean =>
    typeof member === 'string' && (groupNames.has(member) || isBuiltinTarget(member))
  let firstNodeGroup = ''
  for (const group of groups as ProxyGroup[]) {
    let receivesNodes =
      group['include-all'] === true ||
      group['include-all-proxies'] === true ||
      group['include-all-providers'] === true ||
      group.use !== undefined
    if (Array.isArray(group.proxies)) {
      const kept = group.proxies.filter(keep)
      if (kept.length !== group.proxies.length) receivesNodes = true
      if (kept.length > 0) group.proxies = kept
      else delete group.proxies
    }
    // 一个空分组只可能是用来放节点的
    if (group.proxies === undefined) receivesNodes = true
    delete group.use
    delete group['include-all']
    delete group['include-all-providers']
    if (receivesNodes) {
      group['include-all-proxies'] = true
      stats.nodeGroups++
      if (!firstNodeGroup) firstNodeGroup = group.name as string
    } else {
      delete group['include-all-proxies']
    }
  }
  stats.groups = groups.length

  const rules = doc.rules
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('缺少 rules 规则')
  doc.rules = rules.map((item) => {
    if (typeof item !== 'string') throw new Error('rules 里有不是字符串的规则')
    const rule = parseTemplateRule(item)
    if (rule.target !== '' && nodeNames.has(rule.target) && !groupNames.has(rule.target)) {
      if (!firstNodeGroup) throw new Error(`规则指向节点，但没有可放节点的分组: ${item}`)
      rule.target = firstNodeGroup
      stats.retargetedRules++
      return formatTemplateRule(rule)
    }
    return item
  })
  stats.rules = rules.length

  const cleaned = stringify(doc)
  parseSubTemplate(cleaned)
  return { content: cleaned, stats }
}

// ---- 套用 ----

// 把模版套到订阅上：节点永远取自订阅；分组和分流规则取自模版；其它设置默认保留订阅的，
// overrideSettings 时改用模版的。
export function applySubTemplate(
  profile: IMihomoConfig,
  template: MihomoDoc,
  overrideSettings: boolean
): IMihomoConfig {
  const tpl = JSON.parse(JSON.stringify(template)) as MihomoDoc
  const source = profile as unknown as MihomoDoc
  let result: MihomoDoc
  if (overrideSettings) {
    result = { ...tpl }
  } else {
    result = { ...source }
    for (const key of ROUTING_KEYS) {
      if (tpl[key] !== undefined) result[key] = tpl[key]
      else delete result[key]
    }
  }
  for (const key of NODE_KEYS) {
    if (source[key] !== undefined) result[key] = source[key]
    else delete result[key]
  }
  const groups = result['proxy-groups']
  if (Array.isArray(groups)) {
    for (const group of groups as ProxyGroup[]) {
      // include-all 同时包含 proxies 和 proxy-providers 里的节点
      if (group['include-all-proxies'] === true) {
        delete group['include-all-proxies']
        group['include-all'] = true
      }
    }
  }
  return result as unknown as IMihomoConfig
}

// ---- 存储 ----

let subTemplateConfig: ISubTemplateConfig | undefined
// 每次经写队列提交的写入 +1：一次迟到的冷加载 / 强制读取不得用旧内容覆盖比它新的缓存
let subTemplateConfigVersion = 0
// 与 profile.yaml 共用写队列（见 runtimeConfigQueue.ts）：模版选择与订阅内容共同决定运行配置
const subTemplateWriteQueue = runtimeConfigWriteQueue

function normalizeConfig(raw: unknown): ISubTemplateConfig {
  const config = isMapping(raw) ? raw : {}
  const items = Array.isArray(config.items)
    ? (config.items as unknown[])
        .filter(isMapping)
        .map((item) => ({
          id: String(item.id),
          name: typeof item.name === 'string' ? item.name : String(item.id),
          updated: typeof item.updated === 'number' ? item.updated : 0
        }))
        .filter((item) => item.id && item.id !== SUB_TEMPLATE_BUILTIN_ID)
    : []
  const variant = SUB_TEMPLATE_VARIANTS.includes(config.variant as SubTemplateVariant)
    ? (config.variant as SubTemplateVariant)
    : defaultSubTemplateConfig.variant
  let global = typeof config.global === 'string' ? config.global : defaultSubTemplateConfig.global
  if (
    global !== '' &&
    global !== SUB_TEMPLATE_BUILTIN_ID &&
    !items.some((item) => item.id === global)
  ) {
    global = SUB_TEMPLATE_BUILTIN_ID
  }
  return {
    enabled: config.enabled === true,
    global,
    variant,
    overrideSettings: config.overrideSettings === true,
    items
  }
}

async function readConfigFile(): Promise<ISubTemplateConfig> {
  if (!existsSync(subTemplateConfigPath())) return normalizeConfig(defaultSubTemplateConfig)
  return normalizeConfig(parse(await readFile(subTemplateConfigPath(), 'utf-8')))
}

export async function getSubTemplateConfig(force = false): Promise<ISubTemplateConfig> {
  if (force || !subTemplateConfig) {
    const seen = subTemplateConfigVersion
    const loaded = await readConfigFile()
    if (subTemplateConfigVersion === seen || !subTemplateConfig) subTemplateConfig = loaded
  }
  return JSON.parse(JSON.stringify(subTemplateConfig)) as ISubTemplateConfig
}

// 在写队列内部重新读取后再修改，避免并发修改被整体写回吞掉
async function updateSubTemplateConfig(
  updater: (config: ISubTemplateConfig) => ISubTemplateConfig | Promise<ISubTemplateConfig>
): Promise<ISubTemplateConfig> {
  let next: ISubTemplateConfig = defaultSubTemplateConfig
  await subTemplateWriteQueue.run(async () => {
    next = normalizeConfig(await updater(await readConfigFile()))
    await atomicWriteFile(subTemplateConfigPath(), stringify(next), { encoding: 'utf8' })
    subTemplateConfig = next
    subTemplateConfigVersion++
  })
  return next
}

export async function patchSubTemplateConfig(
  patch: Partial<Pick<ISubTemplateConfig, 'enabled' | 'global' | 'variant' | 'overrideSettings'>>
): Promise<ISubTemplateConfig> {
  return updateSubTemplateConfig((config) => {
    if (
      patch.global !== undefined &&
      patch.global !== '' &&
      patch.global !== SUB_TEMPLATE_BUILTIN_ID &&
      !config.items.some((item) => item.id === patch.global)
    ) {
      throw new Error('Template not found')
    }
    return { ...config, ...patch }
  })
}

function cleanTemplateName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('模版名称不能为空')
  if ([...trimmed].length > MAX_TEMPLATE_NAME_LENGTH) throw new Error('模版名称不能超过 64 个字符')
  return trimmed
}

export async function getSubTemplateContent(
  id: string,
  variant?: SubTemplateVariant
): Promise<string> {
  if (id === SUB_TEMPLATE_BUILTIN_ID) {
    return builtinSubTemplateYAML(variant ?? (await getSubTemplateConfig()).variant)
  }
  if (!existsSync(subTemplatePath(id))) throw new Error('Template not found')
  return await readFile(subTemplatePath(id), 'utf-8')
}

// 导入：preview 时只返回清理结果，不保存
export async function importSubTemplate(
  name: string,
  content: string,
  preview = false
): Promise<{ content: string; stats: ISubTemplateStats; item?: ISubTemplateItem }> {
  const cleaned = cleanSubTemplate(content)
  if (preview) return cleaned
  const item: ISubTemplateItem = {
    id: Date.now().toString(16),
    name: cleanTemplateName(name),
    updated: Date.now()
  }
  await atomicWriteFile(subTemplatePath(item.id), cleaned.content, { encoding: 'utf8' })
  await updateSubTemplateConfig((config) => ({ ...config, items: [...config.items, item] }))
  return { ...cleaned, item }
}

export async function fetchSubTemplateUrl(url: string): Promise<string> {
  const { 'mixed-port': mixedPort = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  // 混合端口为 0 表示代理端口已关闭，此时必须直连
  const proxy =
    mixedPort === 0
      ? (false as const)
      : { protocol: 'http' as const, host: '127.0.0.1', port: mixedPort }
  const res = await chromeRequest.get(url, { proxy, responseType: 'text' })
  // chromeRequest 对任何状态码都会 resolve，不校验会把错误页当成模版内容
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Template download failed: status ${res.status}`)
  }
  return res.data as string
}

// 保存编辑后的模版内容：只做校验不做清理，用户手写的内容原样保存
export async function setSubTemplateContent(id: string, content: string): Promise<void> {
  if (id === SUB_TEMPLATE_BUILTIN_ID) throw new Error('内置模版不能修改')
  parseSubTemplate(content)
  await updateSubTemplateConfig(async (config) => {
    const item = config.items.find((i) => i.id === id)
    if (!item) throw new Error('Template not found')
    await atomicWriteFile(subTemplatePath(id), content, { encoding: 'utf8' })
    item.updated = Date.now()
    return config
  })
}

export async function renameSubTemplate(id: string, name: string): Promise<void> {
  const cleaned = cleanTemplateName(name)
  await updateSubTemplateConfig((config) => {
    const item = config.items.find((i) => i.id === id)
    if (!item) throw new Error('Template not found')
    item.name = cleaned
    item.updated = Date.now()
    return config
  })
}

// 删除模版；全局模版是它时回落到内置模版。订阅上残留的引用在套用时按"跟随全局"处理。
export async function removeSubTemplate(id: string): Promise<void> {
  if (id === SUB_TEMPLATE_BUILTIN_ID) throw new Error('内置模版不能删除')
  await updateSubTemplateConfig((config) => ({
    ...config,
    global: config.global === id ? SUB_TEMPLATE_BUILTIN_ID : config.global,
    items: config.items.filter((item) => item.id !== id)
  }))
  await rm(subTemplatePath(id), { force: true })
}

// ---- 解析某个订阅实际使用的模版 ----

// 订阅自己的选择优先；没有选择、或选的模版已被删除时跟随全局
export function resolveSubTemplateId(
  item: Pick<IProfileItem, 'subTemplate'> | undefined,
  config: ISubTemplateConfig
): string | undefined {
  if (!config.enabled) return undefined
  const own = item?.subTemplate
  if (own === SUB_TEMPLATE_NONE) return undefined
  const exists = (id: string): boolean =>
    id === SUB_TEMPLATE_BUILTIN_ID || config.items.some((i) => i.id === id)
  if (own && exists(own)) return own
  if (config.global && exists(config.global)) return config.global
  return undefined
}

export async function loadProfileSubTemplate(
  item: Pick<IProfileItem, 'subTemplate'> | undefined,
  config?: ISubTemplateConfig
): Promise<{ doc: MihomoDoc; overrideSettings: boolean } | undefined> {
  const effective = config ?? (await getSubTemplateConfig())
  const id = resolveSubTemplateId(item, effective)
  if (!id) return undefined
  const content = await getSubTemplateContent(id, effective.variant)
  return { doc: parseSubTemplate(content), overrideSettings: effective.overrideSettings }
}

// 决定一个订阅运行配置的模版状态指纹：插件订阅校验用它判断校验期间模版选择是否变化
export function subTemplateKey(
  item: Pick<IProfileItem, 'subTemplate'> | undefined,
  config: ISubTemplateConfig
): string {
  const id = resolveSubTemplateId(item, config)
  const updated = config.items.find((i) => i.id === id)?.updated ?? 0
  return JSON.stringify({
    id: id ?? null,
    variant: id === SUB_TEMPLATE_BUILTIN_ID ? config.variant : null,
    overrideSettings: id ? config.overrideSettings : null,
    updated
  })
}
