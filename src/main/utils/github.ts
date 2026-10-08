import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { chmod, rename, rm, writeFile } from 'fs/promises'
import { platform } from 'os'
import { setTimeout as delay } from 'timers/promises'
import { promisify } from 'util'
import { gunzipSync } from 'zlib'
import AdmZip from 'adm-zip'
import { hasCoreProcess, restartCore, stopCore } from '../core/manager'
import { getAppConfig, patchAppConfig } from '../config'
import { mihomoCorePath } from './dirs'
import * as chromeRequest from './chromeRequest'
import { createLogger } from './logger'

const execFilePromise = promisify(execFile)
const log = createLogger('GitHub')

export interface GitHubTag {
  name: string
  zipball_url: string
  tarball_url: string
}

interface VersionCache {
  data: GitHubTag[]
  timestamp: number
}

const CACHE_EXPIRY = 5 * 60 * 1000

const GITHUB_API_CONFIG = {
  BASE_URL: 'https://api.github.com',
  API_VERSION: '2022-11-28',
  TAGS_PER_PAGE: 100
}

const PLATFORM_MAP: Record<string, string> = {
  'win32-x64': 'mihomo-windows-amd64-compatible',
  'win32-ia32': 'mihomo-windows-386',
  'win32-arm64': 'mihomo-windows-arm64',
  'darwin-x64': 'mihomo-darwin-amd64-compatible',
  'darwin-arm64': 'mihomo-darwin-arm64',
  'linux-x64': 'mihomo-linux-amd64-compatible',
  'linux-arm64': 'mihomo-linux-arm64'
}

const versionCache = new Map<string, VersionCache>()

/**
 * 获取 GitHub 仓库的标签列表（带缓存）
 * @param owner 仓库所有者
 * @param repo 仓库名称
 * @param forceRefresh 是否强制刷新缓存
 * @returns 标签列表
 */
export async function getGitHubTags(
  owner: string,
  repo: string,
  forceRefresh = false
): Promise<GitHubTag[]> {
  const cacheKey = `${owner}/${repo}`

  // 检查缓存
  if (!forceRefresh && versionCache.has(cacheKey)) {
    const cache = versionCache.get(cacheKey)
    if (cache && Date.now() - cache.timestamp < CACHE_EXPIRY) {
      log.debug(`Returning cached tags for ${owner}/${repo}`)
      return cache.data
    }
  }

  try {
    log.debug(`Fetching tags for ${owner}/${repo}`)
    const response = await chromeRequest.get<GitHubTag[]>(
      `${GITHUB_API_CONFIG.BASE_URL}/repos/${owner}/${repo}/tags?per_page=${GITHUB_API_CONFIG.TAGS_PER_PAGE}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_CONFIG.API_VERSION
        },
        responseType: 'json',
        timeout: 10000
      }
    )

    // 更新缓存
    versionCache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    })

    log.debug(`Successfully fetched ${response.data.length} tags for ${owner}/${repo}`)
    return response.data
  } catch (error) {
    log.error(`Failed to fetch tags for ${owner}/${repo}`, error)
    if (error instanceof Error) {
      throw new Error(`GitHub API error: ${error.message}`)
    }
    throw new Error('Failed to fetch version list')
  }
}

/**
 * 清除版本缓存
 * @param owner 仓库所有者
 * @param repo 仓库名称
 */
export function clearVersionCache(owner: string, repo: string): void {
  const cacheKey = `${owner}/${repo}`
  const hasCache = versionCache.has(cacheKey)
  versionCache.delete(cacheKey)
  log.debug(`Cache ${hasCache ? 'cleared' : 'not found'} for ${owner}/${repo}`)
}

/**
 * 下载 GitHub 资源
 * @param url GitHub 地址
 * @param responseType 返回类型
 * @param timeout 超时时间
 */
async function fetchGitHubResource<T extends 'text' | 'arraybuffer'>(
  url: string,
  responseType: T,
  timeout: number
): Promise<T extends 'text' ? string : Buffer> {
  log.debug(`Downloading ${url}`)
  const response = await chromeRequest.get(url, { responseType, timeout })
  // chromeRequest 对任何状态码都 resolve，所以这里必须自己判断，
  // 否则 404/502 错误页会被当成下载成功写进内核文件。
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Download error: HTTP ${response.status} ${response.statusText} (${url})`)
  }
  const data =
    responseType === 'text' ? String(response.data) : Buffer.from(response.data as Buffer)
  return data as T extends 'text' ? string : Buffer
}

type CoreChannel = 'release' | 'alpha'

const MIHOMO_RELEASES_URL = 'https://github.com/MetaCubeX/mihomo/releases'
const CORE_DOWNLOAD_TIMEOUT = 120000
const VERSION_FETCH_TIMEOUT = 10000

function coreAssetName(): string {
  const key = `${platform()}-${process.arch}`
  const name = PLATFORM_MAP[key]
  if (!name) {
    throw new Error(`Unsupported platform "${key}"`)
  }
  return name
}

function coreDownloadURL(channel: CoreChannel, version: string): string {
  const ext = platform() === 'win32' ? 'zip' : 'gz'
  const tag = channel === 'alpha' ? 'Prerelease-Alpha' : version
  return `${MIHOMO_RELEASES_URL}/download/${tag}/${coreAssetName()}-${version}.${ext}`
}

/**
 * 获取指定通道的最新内核版本号（稳定版形如 v1.19.32，预览版形如 alpha-xxxxxxx）
 */
async function fetchLatestCoreVersion(channel: CoreChannel): Promise<string> {
  const url =
    channel === 'alpha'
      ? `${MIHOMO_RELEASES_URL}/download/Prerelease-Alpha/version.txt`
      : `${MIHOMO_RELEASES_URL}/latest/download/version.txt`
  const version = (await fetchGitHubResource(url, 'text', VERSION_FETCH_TIMEOUT)).trim()
  // 异常时可能返回一整页 HTML，不能把它当版本号拼进下载地址
  if (!/^(v\d+\.\d+\.\d+|alpha-[0-9a-f]+)$/i.test(version)) {
    throw new Error(`Invalid core version response: ${version.slice(0, 64)}`)
  }
  return version
}

/**
 * 读取磁盘上内核文件的真实版本号，内核文件不存在或无法执行时返回 undefined
 */
export async function getCoreBinaryVersion(core: string): Promise<string | undefined> {
  const corePath = mihomoCorePath(core)
  if (!existsSync(corePath)) return undefined
  try {
    const { stdout } = await execFilePromise(corePath, ['-v'], {
      windowsHide: true,
      timeout: 5000
    })
    return stdout.match(/Mihomo Meta (\S+)/)?.[1]
  } catch (error) {
    log.warn(`Failed to read version of ${corePath}`, error)
    return undefined
  }
}

/**
 * 下载内核压缩包并把可执行文件解压到 stagingPath，不触碰正在使用的内核文件
 */
async function downloadCoreToStaging(downloadURL: string, stagingPath: string): Promise<void> {
  const isWin = platform() === 'win32'
  const archive = await fetchGitHubResource(downloadURL, 'arraybuffer', CORE_DOWNLOAD_TIMEOUT)

  let binary: Buffer
  if (isWin) {
    const exeFile = `${coreAssetName()}.exe`
    const entry = new AdmZip(archive).getEntries().find((e) => e.entryName.endsWith(exeFile))
    if (!entry) {
      throw new Error(`Executable file not found in zip: ${exeFile}`)
    }
    binary = entry.getData()
  } else {
    try {
      binary = gunzipSync(archive)
    } catch (error) {
      throw new Error(
        `Gzip decompression failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  await writeFile(stagingPath, binary)
  // 用 chmod 而不是拼 shell 命令：macOS 的数据目录路径里带空格
  if (!isWin) await chmod(stagingPath, 0o755)
}

/**
 * 用 stagingPath 原子替换内核文件。Windows 上内核进程刚退出时文件句柄可能还没释放，
 * 直接替换会报 EBUSY/EPERM，因此短暂重试。
 */
async function replaceCoreBinary(stagingPath: string, targetPath: string): Promise<void> {
  const maxAttempts = 20
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(stagingPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= maxAttempts || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        throw error
      }
      await delay(250)
    }
  }
}

/**
 * 把内核文件替换为 stagingPath。若当前运行的正是这个内核文件，先停止内核，
 * 替换完成（无论成功与否）后再重新启动，保证不会留下一个停止的内核。
 */
async function installStagedCore(core: string, stagingPath: string): Promise<void> {
  const targetPath = mihomoCorePath(core)
  const { core: activeCore = 'mihomo' } = await getAppConfig()
  const needsRestart = activeCore === core && hasCoreProcess()

  if (needsRestart) {
    log.debug('Stopping core before replacing core file')
    await stopCore(true)
  }
  try {
    await replaceCoreBinary(stagingPath, targetPath)
  } finally {
    if (needsRestart) await restartCore()
  }
}

async function withStagingFile<T>(
  core: string,
  task: (stagingPath: string) => Promise<T>
): Promise<T> {
  const stagingPath = `${mihomoCorePath(core)}.download`
  try {
    return await task(stagingPath)
  } finally {
    await rm(stagingPath, { force: true }).catch((error) => {
      log.warn(`Failed to remove temporary file ${stagingPath}`, error)
    })
  }
}

/**
 * 安装特定版本的 mihomo 核心
 * @param version 版本号
 */
export async function installMihomoCore(version: string): Promise<void> {
  try {
    log.info(`Installing mihomo core version ${version}`)
    await withStagingFile('mihomo-specific', async (stagingPath) => {
      await downloadCoreToStaging(coreDownloadURL('release', version), stagingPath)
      await installStagedCore('mihomo-specific', stagingPath)
    })
    log.info(`Successfully installed mihomo core version ${version}`)
  } catch (error) {
    log.error('Failed to install mihomo core', error)
    throw new Error(
      `Failed to install core: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 把当前选择的内核升级到所在通道的最新版本，返回升级后的版本号。
 *
 * 不使用内核自带的 /upgrade 接口：内核在 Windows 上替换自身后会立即拉起一个新进程并退出，
 * 响应常常来不及完整写回（升级成功却报失败），新进程也脱离了客户端的管理。
 * 这里由客户端下载、停止内核、替换文件、重启内核，全程可控。
 */
export async function upgradeMihomoCore(): Promise<string> {
  const { core = 'mihomo' } = await getAppConfig()
  // 特定版本升级到最新稳定版，并同步记录的版本号
  const channel: CoreChannel = core === 'mihomo-alpha' ? 'alpha' : 'release'

  const [latest, current] = await Promise.all([
    fetchLatestCoreVersion(channel),
    getCoreBinaryVersion(core)
  ])
  log.info(`Core upgrade check: core=${core}, current=${current}, latest=${latest}`)
  if (current === latest) {
    // 渲染进程依赖这段文字识别“已是最新版本”
    throw new Error(`already using latest version ${latest}`)
  }

  await withStagingFile(core, async (stagingPath) => {
    await downloadCoreToStaging(coreDownloadURL(channel, latest), stagingPath)
    await installStagedCore(core, stagingPath)
  })

  if (core === 'mihomo-specific') {
    await patchAppConfig({ specificVersion: latest })
  }
  log.info(`Core upgraded to ${latest}`)
  return latest
}
