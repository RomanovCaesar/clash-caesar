import { createHash, randomBytes } from 'crypto'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import http from 'http'
import https from 'https'
import { hostname } from 'os'
import path from 'path'
import tls from 'tls'
import type { Socket } from 'net'
import { app, safeStorage } from 'electron'
import { getControledMihomoConfig } from '../config'
import { dataDir } from '../utils/dirs'
import { createLogger } from '../utils/logger'
import { atomicWriteFile, WriteQueue } from '../utils/safeFile'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { generateDevice, signRequest, verifyRequest } from './plugin/device'
import { browserLogin, CLIENT_ID } from './plugin/oauth'

// 接入 m-ui 联机网络（协议 m-ui-client/1，服务端实现见 m-ui 的 internal/app/client_mesh.go）。
//
// 信任：导入网络文件时信任签发它的面板；之后任何受信任面板签名的网络文档里列出的面板都受信任
// （与 Multi-control 面板之间的信任传递一致）。所有面板响应都带面板签名，面板走 http 也不怕篡改。
// 设备：用管理员账号在浏览器登录后得到签发面板签名的设备证书，每个请求都带证书并用设备私钥签名，
// 网络里任何面板都能直接验证。所以只要能连上任意一个面板，查看网络和拉取订阅都不会断。

const log = createLogger('MuiNetwork')

const SPEC = 'm-ui-client/1'
const FILE_MAGIC = 'MUIN'
const WIRE_BASE = '/_m-ui/client/v1/'
const DOMAIN_NETWORK = 'm-ui-client-network-v1'
const DOMAIN_CERT = 'm-ui-device-cert-v1'
const DOMAIN_REQUEST = 'm-ui-device-request-v1'
const DOMAIN_CONFIG = 'm-ui-client-config-v1'
const REQUEST_TIMEOUT = 8000
const CONFIG_TIMEOUT = 30000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const RENEW_BEFORE = 10 * 24 * 60 * 60 * 1000
const MAX_NODES = 129

interface PeerDescriptor {
  id: string
  publicKey: string
  name: string
  endpoint: string
  revision: number
}

interface NetworkDoc {
  spec: string
  signer: PeerDescriptor
  nodes: (PeerDescriptor & { online?: boolean; lastSeen?: number })[]
  loginUrl?: string
  usernames?: string[]
  issuedAt: number
}

// 存盘的网络记录：在公开视图之外，还有设备证书和加密的设备私钥
interface StoredNetwork extends IMuiNetwork {
  cert?: string
  devicePub?: string
  // safeStorage 加密后的设备私钥（base64）
  devicePrivEnc?: string
  lastGood?: string
}

interface StoreDisk {
  version: 1
  networks: StoredNetwork[]
}

export class MuiError extends Error {
  constructor(
    readonly code:
      | 'invalid_file'
      | 'not_logged_in'
      | 'revoked'
      | 'unreachable'
      | 'not_found'
      | 'bad_response'
      | 'unavailable',
    message: string
  ) {
    // 渲染进程按 [mui:code] 前缀翻译成界面语言
    super(`[mui:${code}] ${message}`)
  }
}

// ---- 签名与身份 ----

export function nodeIdOf(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32)
}

function isPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const raw = Buffer.from(value, 'base64')
  return raw.length === 32 && raw.toString('base64') === value
}

function validDescriptor(node: unknown): node is PeerDescriptor {
  const n = node as PeerDescriptor
  return (
    typeof n === 'object' &&
    n !== null &&
    isPublicKey(n.publicKey) &&
    n.id === nodeIdOf(n.publicKey) &&
    typeof n.name === 'string' &&
    typeof n.endpoint === 'string' &&
    (n.endpoint === '' || /^https?:\/\/[^/?#]+$/.test(n.endpoint)) &&
    Number.isSafeInteger(n.revision)
  )
}

// 信封："<payload base64>.<签名 base64>"，签名对象为 domain + "\0" + payload 字节
export function openEnvelope(envelope: unknown, domain: string, publicKeyB64: string): Buffer {
  if (typeof envelope !== 'string') throw new MuiError('bad_response', 'Invalid signed document')
  const parts = envelope.split('.')
  if (parts.length !== 2) throw new MuiError('bad_response', 'Invalid signed document')
  const payload = Buffer.from(parts[0], 'base64')
  if (payload.toString('base64') !== parts[0]) {
    throw new MuiError('bad_response', 'Invalid signed document')
  }
  const signed = Buffer.concat([Buffer.from(`${domain}\0`), payload])
  if (!verifyRequest(publicKeyB64, signed, parts[1])) {
    throw new MuiError('bad_response', 'Signature verification failed')
  }
  return payload
}

function peekEnvelope(envelope: unknown): unknown {
  if (typeof envelope !== 'string') return undefined
  try {
    return JSON.parse(Buffer.from(envelope.split('.')[0] ?? '', 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

// 校验一份网络文档：签名者必须是 trusted 里的面板（导入文件时传入签名者自己）。
export function verifyNetworkDoc(
  envelope: unknown,
  trusted: (id: string) => string | undefined
): NetworkDoc {
  const doc = peekEnvelope(envelope) as NetworkDoc | undefined
  if (!doc || doc.spec !== SPEC || !validDescriptor(doc.signer)) {
    throw new MuiError('bad_response', 'Invalid network document')
  }
  const key = trusted(doc.signer.id)
  if (!key || key !== doc.signer.publicKey) {
    throw new MuiError('bad_response', 'Network document signed by an unknown panel')
  }
  const verified = JSON.parse(openEnvelope(envelope, DOMAIN_NETWORK, key).toString('utf8'))
  if (!Array.isArray(verified.nodes) || verified.nodes.length > MAX_NODES) {
    throw new MuiError('bad_response', 'Invalid network document')
  }
  verified.nodes = verified.nodes.filter(validDescriptor)
  verified.usernames = Array.isArray(verified.usernames)
    ? verified.usernames.filter((u: unknown) => typeof u === 'string' && u.trim() !== '')
    : []
  return verified as NetworkDoc
}

// ---- 存储 ----

const writeQueue = new WriteQueue()
let store: StoreDisk | undefined

function storePath(): string {
  return path.join(dataDir(), 'mui-networks.json')
}

async function loadStore(): Promise<StoreDisk> {
  if (store) return store
  store = { version: 1, networks: [] }
  if (existsSync(storePath())) {
    try {
      const parsed = JSON.parse(await readFile(storePath(), 'utf-8'))
      if (parsed?.version === 1 && Array.isArray(parsed.networks)) store = parsed as StoreDisk
    } catch (e) {
      log.warn('Failed to read m-ui network store', e)
    }
  }
  return store
}

async function mutate<T>(id: string, change: (network: StoredNetwork) => T): Promise<T> {
  let result: T | undefined
  await writeQueue.run(async () => {
    const disk = await loadStore()
    const network = disk.networks.find((n) => n.id === id)
    if (!network) throw new MuiError('invalid_file', 'Network not found')
    result = change(network)
    await atomicWriteFile(storePath(), JSON.stringify(disk, null, 2), { encoding: 'utf8' })
  })
  return result as T
}

function publicView(network: StoredNetwork): IMuiNetwork {
  const { cert: _c, devicePub: _p, devicePrivEnc: _k, lastGood: _g, ...view } = network
  return JSON.parse(JSON.stringify(view))
}

export async function listMuiNetworks(): Promise<IMuiNetwork[]> {
  return (await loadStore()).networks.map(publicView)
}

async function getNetwork(id: string): Promise<StoredNetwork> {
  const network = (await loadStore()).networks.find((n) => n.id === id)
  if (!network) throw new MuiError('invalid_file', 'Network not found')
  return network
}

function encryptKey(seedB64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new MuiError('unavailable', 'Secure storage is unavailable on this system')
  }
  return safeStorage.encryptString(seedB64).toString('base64')
}

function decryptKey(encrypted: string): string {
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

// 把网络文档并入记录：节点按 ID 合并（ID 由公钥派生），名称和地址取 revision 更新的版本；
// 节点只增不删，暂时离线或暂时没被列出的面板仍保留，以便之后重试。
function mergeDoc(network: StoredNetwork, doc: NetworkDoc): void {
  const now = Date.now()
  for (const item of doc.nodes) {
    let node = network.nodes.find((n) => n.id === item.id)
    if (!node) {
      if (network.nodes.length >= MAX_NODES) continue
      node = { ...item, meshOnline: false }
      network.nodes.push(node)
    } else if (item.revision >= node.revision) {
      node.name = item.name
      node.endpoint = item.endpoint
      node.revision = item.revision
    }
    const online = item.id === doc.signer.id || item.online === true
    // 任何一个能连上的面板报告它在线，就算在线
    node.meshOnline = online || (node.meshLastSeen !== undefined && now - node.meshLastSeen < 60000)
    if (online) node.meshLastSeen = now
    else if (item.lastSeen && (!node.meshLastSeen || item.lastSeen > node.meshLastSeen)) {
      node.meshLastSeen = item.lastSeen
    }
  }
  if (doc.loginUrl && doc.signer.id === network.id) network.loginUrl = doc.loginUrl
  if (doc.usernames?.length) network.usernames = [...doc.usernames].sort()
  network.updatedAt = now
}

// ---- 导入网络文件 ----

export async function importMuiNetworkFile(content: string): Promise<IMuiNetwork> {
  let file: { magic?: string; v?: number; spec?: string; network?: string }
  try {
    file = JSON.parse(content)
  } catch {
    throw new MuiError('invalid_file', 'Not an m-ui network file')
  }
  if (file?.magic !== FILE_MAGIC || file.v !== 1 || file.spec !== SPEC) {
    throw new MuiError('invalid_file', 'Not an m-ui network file')
  }
  // 导入即信任签发面板：文件来自用户自己的面板
  const signer = (peekEnvelope(file.network) as NetworkDoc | undefined)?.signer
  if (!signer || !validDescriptor(signer)) {
    throw new MuiError('invalid_file', 'Not an m-ui network file')
  }
  const doc = verifyNetworkDoc(file.network, (id) =>
    id === signer.id ? signer.publicKey : undefined
  )
  if (!doc.loginUrl || !/^https?:\/\//.test(doc.loginUrl)) {
    throw new MuiError('invalid_file', 'The network file has no login address')
  }
  let view: IMuiNetwork | undefined
  await writeQueue.run(async () => {
    const disk = await loadStore()
    let network = disk.networks.find((n) => n.id === doc.signer.id)
    if (!network) {
      network = {
        id: doc.signer.id,
        name: doc.signer.name,
        loginUrl: doc.loginUrl ?? '',
        nodes: [],
        usernames: [],
        loggedIn: false
      }
      disk.networks.push(network)
    }
    network.name = doc.signer.name
    mergeDoc(network, doc)
    if (!network.username && network.usernames.length) network.username = network.usernames[0]
    await atomicWriteFile(storePath(), JSON.stringify(disk, null, 2), { encoding: 'utf8' })
    view = publicView(network)
  })
  return view as IMuiNetwork
}

export async function removeMuiNetwork(id: string): Promise<void> {
  await writeQueue.run(async () => {
    const disk = await loadStore()
    disk.networks = disk.networks.filter((n) => n.id !== id)
    await atomicWriteFile(storePath(), JSON.stringify(disk, null, 2), { encoding: 'utf8' })
  })
}

export async function setMuiUsername(id: string, username: string): Promise<IMuiNetwork> {
  return mutate(id, (network) => {
    if (!network.usernames.includes(username)) {
      throw new MuiError('not_found', 'Unknown username')
    }
    network.username = username
    return publicView(network)
  })
}

// ---- HTTP ----

interface WireResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function collect(
  res: http.IncomingMessage,
  resolve: (value: WireResponse) => void,
  reject: (reason: Error) => void
): void {
  const chunks: Buffer[] = []
  let size = 0
  res.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_RESPONSE_BYTES) {
      res.destroy(new Error('Response too large'))
      return
    }
    chunks.push(chunk)
  })
  res.on('end', () =>
    resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
  )
  res.on('error', reject)
}

// 直连面板，不经系统代理，不跟随重定向，HTTPS 正常校验证书
function directRequest(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeout: number
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      target,
      {
        method,
        headers: { ...headers, 'Content-Length': String(body.length) },
        timeout,
        agent: false
      },
      (res) => collect(res, resolve, reject)
    )
    req.on('timeout', () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

// 直连失败时经本机 mihomo 的混合端口再试一次（面板被直连屏蔽、但代理可达的情况）
function proxiedRequest(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeout: number,
  proxyPort: number
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const allHeaders = { ...headers, 'Content-Length': String(body.length) }
    if (target.protocol === 'http:') {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method,
          path: target.toString(),
          headers: { ...allHeaders, Host: target.host },
          timeout,
          agent: false
        },
        (res) => collect(res, resolve, reject)
      )
      req.on('timeout', () => req.destroy(new Error('Request timed out')))
      req.on('error', reject)
      req.end(body)
      return
    }
    const port = target.port || '443'
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
      timeout,
      agent: false
    })
    connect.on('timeout', () => connect.destroy(new Error('Request timed out')))
    connect.on('error', reject)
    connect.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`Proxy refused: HTTP ${res.statusCode}`))
        return
      }
      if (head.length > 0) socket.unshift(head)
      // 请求选项里的 createConnection 只在不用 agent 时生效，所以单独建一个 agent 让它的连接就是隧道
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
      Object.assign(agent, {
        createConnection: (): Socket => tls.connect({ socket, servername: target.hostname })
      })
      const req = https.request(target, { method, headers: allHeaders, timeout, agent }, (r) =>
        collect(r, resolve, reject)
      )
      req.on('timeout', () => req.destroy(new Error('Request timed out')))
      req.on('error', reject)
      req.end(body)
    })
    connect.end()
  })
}

async function wireRequest(
  endpoint: string,
  pathAndQuery: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeout: number
): Promise<WireResponse> {
  const target = new URL(endpoint + pathAndQuery)
  try {
    return await directRequest(target, method, headers, body, timeout)
  } catch (directError) {
    const { 'mixed-port': mixedPort = DEFAULT_MIHOMO_PORTS.mixed } =
      await getControledMihomoConfig()
    if (!mixedPort) throw directError
    try {
      return await proxiedRequest(target, method, headers, body, timeout, mixedPort)
    } catch {
      throw directError
    }
  }
}

// ---- 设备请求 ----

function deviceKeys(network: StoredNetwork): { cert: string; seed: string } {
  if (!network.cert || !network.devicePrivEnc || !network.loggedIn) {
    throw new MuiError('not_logged_in', 'Please sign in to this network first')
  }
  return { cert: network.cert, seed: decryptKey(network.devicePrivEnc) }
}

interface SignedResult {
  node: StoredNetwork['nodes'][number]
  response: WireResponse
  nonce: string
  latency: number
}

async function signedRequest(
  network: StoredNetwork,
  node: IMuiNode,
  method: 'GET' | 'POST',
  pathAndQuery: string,
  timeout = REQUEST_TIMEOUT
): Promise<SignedResult> {
  const { cert, seed } = deviceKeys(network)
  const body = Buffer.alloc(0)
  const timestamp = String(Date.now())
  const nonce = randomBytes(18).toString('base64url')
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const input = Buffer.from(
    [DOMAIN_REQUEST, method, pathAndQuery, timestamp, nonce, bodyHash].join('\0'),
    'utf8'
  )
  const started = Date.now()
  const response = await wireRequest(
    node.endpoint,
    pathAndQuery,
    method,
    {
      'X-MUI-Cert': cert,
      'X-MUI-Time': timestamp,
      'X-MUI-Nonce': nonce,
      'X-MUI-Sig': signRequest(seed, input),
      'User-Agent': `clash.caesar/v${app.getVersion()}`
    },
    body,
    timeout
  )
  return { node, response, nonce, latency: Date.now() - started }
}

function wireError(response: WireResponse): { code: string; message: string } {
  try {
    const parsed = JSON.parse(response.body.toString('utf8'))
    return { code: String(parsed.error ?? ''), message: String(parsed.message ?? '') }
  } catch {
    return { code: '', message: `HTTP ${response.status}` }
  }
}

function trustedKey(network: StoredNetwork): (id: string) => string | undefined {
  return (id) => network.nodes.find((n) => n.id === id)?.publicKey
}

// 依次尝试面板：preferred → 上次成功的 → 本机能连上的 → 网络里在线的 → 其余。
// 网络层失败、超时、5xx 和"证书不被这个面板认可"会换下一个面板；吊销立即停止。
async function withFailover<T>(
  networkId: string,
  preferred: string | undefined,
  attempt: (network: StoredNetwork, node: IMuiNode) => Promise<T>
): Promise<T> {
  const network = await getNetwork(networkId)
  const rank = (node: IMuiNode): number =>
    node.id === preferred
      ? 0
      : node.id === network.lastGood
        ? 1
        : node.reachable
          ? 2
          : node.meshOnline
            ? 3
            : 4
  const candidates = network.nodes
    .filter((n) => n.endpoint)
    .sort((a, b) => rank(a) - rank(b) || (a.latency ?? 1e9) - (b.latency ?? 1e9))
  let lastError: unknown = new MuiError('unreachable', 'No panel in this network is reachable')
  for (const node of candidates) {
    try {
      const result = await attempt(network, node)
      await mutate(networkId, (n) => {
        n.lastGood = node.id
        n.lastError = undefined
      })
      return result
    } catch (e) {
      if (e instanceof MuiError && (e.code === 'revoked' || e.code === 'not_found')) throw e
      if (e instanceof MuiError && e.code === 'not_logged_in') throw e
      lastError = e
      log.warn(`m-ui panel ${node.name} (${node.endpoint}) failed`, e)
    }
  }
  throw lastError
}

async function markRevoked(networkId: string): Promise<never> {
  await mutate(networkId, (n) => {
    n.loggedIn = false
    n.needsLogin = true
  })
  throw new MuiError('revoked', 'This device has been revoked; please sign in again')
}

function checkResponse(network: StoredNetwork, result: SignedResult): void {
  const { response } = result
  if (response.status === 200) return
  const { code, message } = wireError(response)
  if (code === 'revoked') throw new MuiError('revoked', message || 'revoked')
  if (code === 'not_found') throw new MuiError('not_found', message || 'not found')
  throw new MuiError('unreachable', message || `HTTP ${response.status} from ${network.name}`)
}

// ---- 登录 ----

export async function loginMuiNetwork(id: string): Promise<IMuiNetwork> {
  const network = await getNetwork(id)
  const loginUrl = new URL(network.loginUrl)
  loginUrl.searchParams.set('device_name', `Clash Caesar · ${hostname()}`.slice(0, 64))
  const oauth = await browserLogin(loginUrl.toString())
  const device = generateDevice()
  const body = Buffer.from(
    JSON.stringify({
      code: oauth.code,
      codeVerifier: oauth.verifier,
      redirectUri: oauth.redirectUri,
      clientId: CLIENT_ID,
      deviceId: device.deviceId,
      publicKey: device.pubKeyB64
    })
  )
  const response = await wireRequest(
    loginUrl.origin,
    `${WIRE_BASE}enroll`,
    'POST',
    { 'Content-Type': 'application/json' },
    body,
    REQUEST_TIMEOUT
  )
  if (response.status !== 200) {
    const { message } = wireError(response)
    throw new MuiError('bad_response', message || `HTTP ${response.status}`)
  }
  const result = JSON.parse(response.body.toString('utf8')) as { cert?: string; network?: string }
  const issuer = network.nodes.find((n) => loginUrl.origin === n.endpoint) ?? null
  const certPayload = peekEnvelope(result.cert) as
    { issuer?: string; deviceId?: string } | undefined
  const issuerKey = network.nodes.find((n) => n.id === certPayload?.issuer)?.publicKey
  if (!issuerKey || certPayload?.deviceId !== device.deviceId) {
    throw new MuiError('bad_response', 'The panel returned an invalid device certificate')
  }
  const cert = JSON.parse(openEnvelope(result.cert, DOMAIN_CERT, issuerKey).toString('utf8'))
  const doc = verifyNetworkDoc(result.network, trustedKey(network))
  return mutate(id, (n) => {
    n.cert = result.cert
    n.deviceId = device.deviceId
    n.devicePub = device.pubKeyB64
    n.devicePrivEnc = encryptKey(device.privKeyB64)
    n.certExpiresAt = cert.expiresAt
    n.loggedIn = true
    n.needsLogin = false
    n.lastGood = issuer?.id ?? n.lastGood
    mergeDoc(n, doc)
    if (!n.username || !n.usernames.includes(n.username)) n.username = n.usernames[0]
    return publicView(n)
  })
}

// ---- 网络状态 ----

async function renewIfNeeded(networkId: string): Promise<void> {
  const network = await getNetwork(networkId)
  if (!network.loggedIn || !network.certExpiresAt) return
  if (network.certExpiresAt - Date.now() > RENEW_BEFORE) return
  const cert = await withFailover(networkId, undefined, async (n, node) => {
    const result = await signedRequest(n, node, 'POST', `${WIRE_BASE}renew`)
    checkResponse(n, result)
    const envelope = JSON.parse(result.response.body.toString('utf8')).cert
    const payload = peekEnvelope(envelope) as { issuer?: string } | undefined
    const key = n.nodes.find((x) => x.id === payload?.issuer)?.publicKey
    if (!key) throw new MuiError('bad_response', 'Unknown certificate issuer')
    return {
      envelope,
      expiresAt: JSON.parse(openEnvelope(envelope, DOMAIN_CERT, key).toString('utf8')).expiresAt
    }
  })
  await mutate(networkId, (n) => {
    n.cert = cert.envelope
    n.certExpiresAt = cert.expiresAt
  })
}

// 逐个联系所有面板：记录本机能否连上和延迟，并把各面板签名的网络文档合并进来
export async function refreshMuiNetwork(id: string): Promise<IMuiNetwork> {
  try {
    await renewIfNeeded(id)
  } catch (e) {
    if (e instanceof MuiError && e.code === 'revoked') await markRevoked(id)
    log.warn('Certificate renewal failed', e)
  }
  const network = await getNetwork(id)
  deviceKeys(network)
  const results = await Promise.all(
    network.nodes
      .filter((n) => n.endpoint)
      .map(async (node) => {
        try {
          const result = await signedRequest(network, node, 'GET', `${WIRE_BASE}network`)
          checkResponse(network, result)
          const envelope = JSON.parse(result.response.body.toString('utf8')).network
          const doc = verifyNetworkDoc(envelope, trustedKey(network))
          if (doc.signer.id !== node.id) throw new MuiError('bad_response', 'Unexpected signer')
          return { id: node.id, ok: true as const, latency: result.latency, doc }
        } catch (e) {
          return { id: node.id, ok: false as const, error: e }
        }
      })
  )
  if (results.some((r) => !r.ok && r.error instanceof MuiError && r.error.code === 'revoked')) {
    await markRevoked(id)
  }
  return mutate(id, (n) => {
    const now = Date.now()
    for (const result of results) {
      const node = n.nodes.find((x) => x.id === result.id)
      if (!node) continue
      node.checkedAt = now
      node.reachable = result.ok
      if (result.ok) {
        node.latency = result.latency
        node.error = undefined
      } else {
        node.latency = undefined
        node.error = result.error instanceof Error ? result.error.message : String(result.error)
      }
    }
    for (const result of results) if (result.ok) mergeDoc(n, result.doc)
    if (!results.some((r) => r.ok)) {
      n.lastError = 'unreachable'
      // 一个面板都连不上时不知道网络里的真实情况，不再把它们当作在线
      for (const node of n.nodes) node.meshOnline = false
    } else {
      n.lastError = undefined
    }
    if (!n.username || !n.usernames.includes(n.username)) n.username = n.usernames[0]
    return publicView(n)
  })
}

// ---- 订阅 ----

// 拉取某个 Username 的订阅：source 为面板 ID 时先直连那个面板，连不上再请其它面板用缓存代为生成；
// 为 'merged' 时任何一个面板都能给出融合订阅。
export async function fetchMuiSubscription(
  networkId: string,
  source: string,
  username: string
): Promise<{ data: string; headers: Record<string, string> }> {
  try {
    await renewIfNeeded(networkId)
  } catch (e) {
    log.warn('Certificate renewal failed', e)
  }
  const query = new URLSearchParams({ username, source }).toString()
  try {
    return await withFailover(
      networkId,
      source === 'merged' ? undefined : source,
      async (n, node) => {
        const result = await signedRequest(
          n,
          node,
          'GET',
          `${WIRE_BASE}config?${query}`,
          CONFIG_TIMEOUT
        )
        checkResponse(n, result)
        const { response, nonce } = result
        const signer = String(response.headers['x-mui-signer'] ?? '')
        const key = n.nodes.find((x) => x.id === signer)?.publicKey
        const hash = createHash('sha256').update(response.body).digest('hex')
        if (
          !key ||
          !verifyRequest(
            key,
            Buffer.from(`${DOMAIN_CONFIG}\0${nonce}\0${hash}`, 'utf8'),
            String(response.headers['x-mui-signature'] ?? '')
          )
        ) {
          throw new MuiError('bad_response', 'Subscription signature verification failed')
        }
        const headers: Record<string, string> = {}
        for (const name of ['subscription-userinfo', 'profile-update-interval']) {
          const value = response.headers[name]
          if (typeof value === 'string') headers[name] = value
        }
        return { data: response.body.toString('utf8'), headers }
      }
    )
  } catch (e) {
    if (e instanceof MuiError && e.code === 'revoked') await markRevoked(networkId)
    throw e
  }
}

// 导入某个面板（或融合）的订阅为 'mui' 类型的订阅；同一网络、来源、Username 只保留一份
export async function importMuiSubscription(
  networkId: string,
  source: string,
  name: string
): Promise<void> {
  const network = await getNetwork(networkId)
  if (!network.username) throw new MuiError('not_found', 'No username selected')
  if (source !== 'merged' && !network.nodes.some((n) => n.id === source)) {
    throw new MuiError('not_found', 'Panel not found')
  }
  const id = `mui-${createHash('sha256').update(`${networkId}\0${source}\0${network.username}`).digest('hex').slice(0, 16)}`
  const { addProfileItem } = await import('../config')
  await addProfileItem({
    id,
    type: 'mui',
    name,
    muiNetworkId: networkId,
    muiSource: source,
    muiUsername: network.username,
    autoUpdate: true
  })
}
