import { copyFile, mkdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import {
  getControledMihomoConfig,
  getProfileConfig,
  getProfile,
  getProfileItem,
  getAppConfig
} from '../config'
import { applySubTemplate, loadProfileSubTemplate } from '../config/subTemplate'
import { mihomoProfileWorkDir, mihomoWorkConfigPath, mihomoWorkDir, rulePath } from '../utils/dirs'
import { parse, stringify } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { createLogger } from '../utils/logger'
import { DEFAULT_CONTROL_DNS, DEFAULT_CONTROL_SNIFF } from '../../shared/appConfig'
import { atomicWriteFile } from '../utils/safeFile'
import { addNodeGeoProbes } from '../resolve/nodeGeo'
import { evaluateDnsOverrideGuard, type DnsOverrideGuardResult } from './dnsOverrideGuard'

const factoryLogger = createLogger('Factory')

let runtimeConfigStr: string = ''
let runtimeConfig: IMihomoConfig = {} as IMihomoConfig

interface GenerateProfileOptions {
  profileId?: string
  baseProfile?: IMihomoConfig
  // 校验候选订阅时使用的订阅项（其中的模版选择），不给出时读取已保存的订阅项
  profileItem?: IProfileItem
  // 调用方已读取的订阅模版设置：给出时不再自行读取，生成所用的模版与调用方记录的完全一致
  //（插件订阅校验用它把"参与校验的模版"绑定到校验本身）
  subTemplateConfig?: ISubTemplateConfig
  outputPath?: string
  updateRuntimeConfig?: boolean
}

export interface GenerateProfileResult {
  profileId: string | undefined
  // 随本次配置成功应用后同步。
  dnsGuard: DnsOverrideGuardResult
}

// 辅助函数：处理带偏移量的规则
function processRulesWithOffset(ruleStrings: string[], currentRules: string[], isAppend = false) {
  const normalRules: string[] = []
  const rules = [...currentRules]

  ruleStrings.forEach((ruleStr) => {
    const parts = ruleStr.split(',')
    const firstPartIsNumber =
      !isNaN(Number(parts[0])) && parts[0].trim() !== '' && parts.length >= 3

    if (firstPartIsNumber) {
      const offset = parseInt(parts[0])
      const rule = parts.slice(1).join(',')

      if (isAppend) {
        // 后置规则的插入位置计算
        const insertPosition = Math.max(0, rules.length - Math.min(offset, rules.length))
        rules.splice(insertPosition, 0, rule)
      } else {
        // 前置规则的插入位置计算
        const insertPosition = Math.min(offset, rules.length)
        rules.splice(insertPosition, 0, rule)
      }
    } else {
      normalRules.push(ruleStr)
    }
  })

  return { normalRules, insertRules: rules }
}

export async function generateProfile(
  pendingControledMihomoConfig?: Partial<IMihomoConfig>,
  options: GenerateProfileOptions = {}
): Promise<GenerateProfileResult> {
  // 第一阶段：并行读取互不依赖的配置（强制重读 profileConfig 完成后再进入第二阶段，保证缓存一致）。
  const [profileConfig, appConfig] = await Promise.all([getProfileConfig(true), getAppConfig()])
  const { current } = profileConfig
  const profileId = options.profileId ?? current
  // 第二阶段：仅依赖 profileId 的读取并行执行。
  const [currentProfileItem, baseProfile, fetchedControledMihomoConfig] = await Promise.all([
    options.profileItem ?? getProfileItem(profileId),
    options.baseProfile ?? getProfile(profileId),
    getControledMihomoConfig()
  ])
  let controledMihomoConfig = pendingControledMihomoConfig ?? fetchedControledMihomoConfig
  const {
    diffWorkDir = false,
    controlDns: controlDnsSetting = DEFAULT_CONTROL_DNS,
    controlSniff = DEFAULT_CONTROL_SNIFF,
    useNameserverPolicy
  } = appConfig
  // DNS 保护先于订阅模版处理，开关在内核应用成功后同步。
  const dnsGuard = evaluateDnsOverrideGuard(
    profileId ?? 'default',
    baseProfile,
    controlDnsSetting,
    options.updateRuntimeConfig !== false
  )
  const { controlDns } = dnsGuard
  // 订阅模版：订阅文件原样不动，只在生成运行配置时把分组和规则换成模版的
  const template = await loadProfileSubTemplate(currentProfileItem, options.subTemplateConfig)
  const templatedProfile = template
    ? applySubTemplate(baseProfile, template.doc, template.overrideSettings)
    : baseProfile
  const currentProfile = await applyRuleOverride(profileId, templatedProfile)

  // 根据开关状态过滤控制配置
  controledMihomoConfig = { ...controledMihomoConfig }
  if (!controlDns) {
    delete controledMihomoConfig.dns
    delete controledMihomoConfig.hosts
  }
  if (!controlSniff) {
    delete controledMihomoConfig.sniffer
  }
  if (!useNameserverPolicy) {
    delete controledMihomoConfig?.dns?.['nameserver-policy']
  }

  const profile = deepMerge(currentProfile, controledMihomoConfig)
  // 关闭 DNS 覆写时，如果最终配置没有启用的 DNS 配置，清空 dns-hijack 避免请求被劫持但无法处理
  if (!controlDns && profile.tun && !profile.dns?.enable) {
    profile.tun = { ...profile.tun, 'dns-hijack': [] }
  }
  // 删除空的局域网允许列表，避免局域网访问异常
  if (!profile['lan-allowed-ips']?.length) {
    delete profile['lan-allowed-ips']
  }
  // WebUI 仅在外部控制器启用时有效；关闭面板时不向 Mihomo 写入下载地址。
  const partialProfile = profile as Partial<IMihomoConfig>
  if (profile['external-controller'] === '') {
    delete partialProfile['external-controller']
    delete partialProfile['external-ui']
    delete partialProfile['external-ui-url']
    delete partialProfile['external-controller-cors']
  } else if (profile['external-ui'] === '') {
    delete partialProfile['external-ui']
    delete partialProfile['external-ui-url']
  }
  const nextRuntimeConfigStr = stringify(profile)
  const coreProfile = { ...profile }
  // 日志解析启动检测需要基础日志；预览和 Gist 保留用户的实际配置。
  if (['info', 'debug'].includes(coreProfile['log-level']) === false) {
    coreProfile['log-level'] = 'info'
  }
  // 节点出口位置的探测通道只加进内核实际加载的配置；订阅校验等临时生成不需要
  if (options.outputPath === undefined && options.updateRuntimeConfig !== false) {
    await addNodeGeoProbes(coreProfile)
  }
  const coreConfigStr = stringify(coreProfile)
  if (diffWorkDir && options.outputPath === undefined) {
    await prepareProfileWorkDir(profileId)
  }
  await atomicWriteFile(
    options.outputPath ??
      (diffWorkDir ? mihomoWorkConfigPath(profileId) : mihomoWorkConfigPath('work')),
    coreConfigStr
  )
  if (options.updateRuntimeConfig !== false) {
    runtimeConfig = profile
    runtimeConfigStr = nextRuntimeConfigStr
  }
  return { profileId, dnsGuard }
}

async function applyRuleOverride(
  current: string | undefined,
  profile: IMihomoConfig
): Promise<IMihomoConfig> {
  try {
    const ruleFilePath = rulePath(current || 'default')
    if (!existsSync(ruleFilePath)) {
      return profile
    }

    const ruleFileContent = await readFile(ruleFilePath, 'utf-8')
    const ruleData = parse(ruleFileContent) as {
      prepend?: string[]
      append?: string[]
      delete?: string[]
    } | null

    if (!ruleData || typeof ruleData !== 'object') {
      return profile
    }

    if (!profile.rules) {
      profile.rules = [] as unknown as []
    }

    let rules = [...profile.rules] as unknown as string[]

    if (ruleData.prepend?.length) {
      const { normalRules: prependRules, insertRules } = processRulesWithOffset(
        ruleData.prepend,
        rules
      )
      rules = [...prependRules, ...insertRules]
    }

    if (ruleData.append?.length) {
      const { normalRules: appendRules, insertRules } = processRulesWithOffset(
        ruleData.append,
        rules,
        true
      )
      rules = [...insertRules, ...appendRules]
    }

    if (ruleData.delete?.length) {
      const deleteSet = new Set(ruleData.delete)
      rules = rules.filter((rule) => {
        const ruleStr = Array.isArray(rule) ? rule.join(',') : rule
        return !deleteSet.has(ruleStr)
      })
    }

    profile.rules = rules as unknown as []
    return profile
  } catch (error) {
    factoryLogger.error('Failed to read or apply rule file', error)
    return profile
  }
}

async function prepareProfileWorkDir(current: string | undefined): Promise<void> {
  if (!existsSync(mihomoProfileWorkDir(current))) {
    await mkdir(mihomoProfileWorkDir(current), { recursive: true })
  }

  const isSourceNewer = async (sourcePath: string, targetPath: string): Promise<boolean> => {
    try {
      const [sourceStats, targetStats] = await Promise.all([stat(sourcePath), stat(targetPath)])
      return sourceStats.mtime > targetStats.mtime
    } catch {
      return true
    }
  }

  const copy = async (file: string): Promise<void> => {
    const targetPath = path.join(mihomoProfileWorkDir(current), file)
    const sourcePath = path.join(mihomoWorkDir(), file)
    if (!existsSync(sourcePath)) return
    // 复制条件：目标不存在 或 源文件更新
    const shouldCopy = !existsSync(targetPath) || (await isSourceNewer(sourcePath, targetPath))
    if (shouldCopy) {
      await copyFile(sourcePath, targetPath)
    }
  }
  await Promise.all([
    copy('country.mmdb'),
    copy('geoip.metadb'),
    copy('geoip.dat'),
    copy('geosite.dat'),
    copy('ASN.mmdb'),
    copy('BundleMRS.7z')
  ])
}

export async function getRuntimeConfigStr(): Promise<string> {
  return runtimeConfigStr
}

export async function getRuntimeConfig(): Promise<IMihomoConfig> {
  return runtimeConfig
}
