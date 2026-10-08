import { createHash } from 'crypto'
import { dialog } from 'electron'
import * as chromeRequest from '../utils/chromeRequest'
import { getAppConfig } from '../config/app'
import { getControledMihomoConfig } from '../config/controledMihomo'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { getRuntimeConfigStr } from '../core/factory'
import { encryptAgeContent, generateAgeKeyPair } from '../utils/age'
import { createLogger } from '../utils/logger'
import { atomicWriteFile } from '../utils/safeFile'

interface GistInfo {
  id: string
  description: string
  html_url: string
}

interface GistAgeKeyPair {
  secretKey: string
  recipient: string
}

const gistApiLogger = createLogger('GistApi')
let runtimeConfigUploadTimer: ReturnType<typeof setTimeout> | undefined
let runtimeConfigUploadQueue: Promise<void> = Promise.resolve()
let lastUploadedRuntimeConfigHash: string | undefined
let uploadingRuntimeConfigHash: string | undefined

function hashRuntimeConfig(runtimeConfig: string): string {
  return createHash('sha256').update(runtimeConfig).digest('hex')
}

// chromeRequest 对任何状态码都会 resolve，不校验状态码的话 token 失效（401/403）会被当成成功：
// 错误响应体被当作「远端没有这个 gist」，上传也「成功」，哈希被记为已同步后就再也不会重试
function assertGithubOk(res: chromeRequest.Response, action: string): void {
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    throw new Error(`GitHub API ${action} failed with status ${res.status}: ${detail}`)
  }
}

async function listGists(token: string): Promise<GistInfo[]> {
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const res = await chromeRequest.get('https://api.github.com/gists', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    proxy: {
      protocol: 'http',
      host: '127.0.0.1',
      port
    },
    responseType: 'json'
  })
  assertGithubOk(res, 'list gists')
  return Array.isArray(res.data) ? res.data : []
}

async function createGist(token: string, content: string): Promise<void> {
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const res = await chromeRequest.post(
    'https://api.github.com/gists',
    {
      description: 'Auto Synced Clash Party Runtime Config',
      public: false,
      files: { 'clash-party.yaml': { content } }
    },
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port
      }
    }
  )
  assertGithubOk(res, 'create gist')
}

async function updateGist(token: string, id: string, content: string): Promise<void> {
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const res = await chromeRequest.patch(
    `https://api.github.com/gists/${id}`,
    {
      description: 'Auto Synced Clash Party Runtime Config',
      files: { 'clash-party.yaml': { content } }
    },
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port
      }
    }
  )
  assertGithubOk(res, 'update gist')
}

export async function getGistUrl(): Promise<string> {
  const { githubToken } = await getAppConfig()
  if (!githubToken) return ''
  const gists = await listGists(githubToken)
  const gist = gists.find((gist) => gist.description === 'Auto Synced Clash Party Runtime Config')
  if (gist) {
    return gist.html_url
  } else {
    await uploadRuntimeConfig()
    const gists = await listGists(githubToken)
    const gist = gists.find((gist) => gist.description === 'Auto Synced Clash Party Runtime Config')
    if (!gist) throw new Error('Gist not found')
    return gist.html_url
  }
}

async function uploadRuntimeConfigContent(runtimeConfig: string): Promise<boolean> {
  const { githubToken, gistAgeEncrypt = false, gistAgeRecipient } = await getAppConfig()
  if (!githubToken) return false
  const gists = await listGists(githubToken)
  const gist = gists.find((gist) => gist.description === 'Auto Synced Clash Party Runtime Config')
  const config = gistAgeEncrypt
    ? await encryptAgeContent(runtimeConfig, gistAgeRecipient, 'gist runtime config')
    : runtimeConfig
  if (gist) {
    await updateGist(githubToken, gist.id, config)
  } else {
    await createGist(githubToken, config)
  }
  return true
}

export async function uploadRuntimeConfig(): Promise<void> {
  const runtimeConfig = await getRuntimeConfigStr()
  const runtimeConfigHash = hashRuntimeConfig(runtimeConfig)
  uploadingRuntimeConfigHash = runtimeConfigHash
  try {
    const uploaded = await uploadRuntimeConfigContent(runtimeConfig)
    if (uploaded) {
      lastUploadedRuntimeConfigHash = runtimeConfigHash
    }
  } finally {
    if (uploadingRuntimeConfigHash === runtimeConfigHash) {
      uploadingRuntimeConfigHash = undefined
    }
  }
}

export async function uploadRuntimeConfigIfChanged(): Promise<void> {
  const runtimeConfig = await getRuntimeConfigStr()
  const runtimeConfigHash = hashRuntimeConfig(runtimeConfig)
  if (
    runtimeConfigHash === lastUploadedRuntimeConfigHash ||
    runtimeConfigHash === uploadingRuntimeConfigHash
  ) {
    return
  }

  uploadingRuntimeConfigHash = runtimeConfigHash
  try {
    const uploaded = await uploadRuntimeConfigContent(runtimeConfig)
    if (uploaded) {
      lastUploadedRuntimeConfigHash = runtimeConfigHash
    }
  } finally {
    if (uploadingRuntimeConfigHash === runtimeConfigHash) {
      uploadingRuntimeConfigHash = undefined
    }
  }
}

export function scheduleRuntimeConfigUpload(): void {
  if (runtimeConfigUploadTimer) {
    clearTimeout(runtimeConfigUploadTimer)
  }

  runtimeConfigUploadTimer = setTimeout(() => {
    runtimeConfigUploadTimer = undefined
    runtimeConfigUploadQueue = runtimeConfigUploadQueue
      .catch(() => {})
      .then(async () => {
        try {
          await uploadRuntimeConfigIfChanged()
        } catch (error) {
          gistApiLogger.warn('Failed to sync runtime config to Gist', error)
        }
      })
  }, 300)
}

export async function generateGistAgeKeyPair(): Promise<GistAgeKeyPair> {
  return await generateAgeKeyPair()
}

export async function exportGistAgeSecretKey(): Promise<boolean> {
  const { gistAgeSecretKey } = await getAppConfig()
  if (!gistAgeSecretKey) {
    throw new Error('Gist Age private key has not been generated')
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Gist Age Private Key',
    defaultPath: 'clash-party-gist-age-secret-key.txt',
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })

  if (canceled || !filePath) return false

  await atomicWriteFile(filePath, `${gistAgeSecretKey.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}
