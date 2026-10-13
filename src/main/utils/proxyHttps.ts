import http from 'http'
import https from 'https'
import type { Socket } from 'net'
import tls from 'tls'

const REQUEST_TIMEOUT = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024

// 经本机 HTTP 代理端口（CONNECT）发起一次 HTTPS GET。
// 隧道由 http 模块的 CONNECT 建立，再交给 https 模块完成 TLS 和 HTTP：自己读写套接字时，
// 读完代理响应后套接字仍处于流动模式，部分节点的 TLS 数据会被错误消费，导致 BAD_DECRYPT。
// 每次请求都新建隧道并在响应后关闭：复用连接会让切换节点后的请求仍走上一个节点。
export function httpsGetViaProxy(
  port: number,
  host: string,
  requestPath: string,
  timeout = REQUEST_TIMEOUT
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let tunnel: Socket | undefined
    const finish = (error: Error | null, result?: { status: number; body: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connect.destroy()
      tunnel?.destroy()
      if (error || !result) reject(error ?? new Error('Empty response'))
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error(`Request to ${host} timed out`)), timeout)

    const connect = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { Host: `${host}:443` },
      agent: false
    })
    connect.once('error', (e) => finish(e))
    connect.once('connect', (res, socket, head) => {
      tunnel = socket
      if (res.statusCode !== 200) {
        finish(new Error(`Proxy refused: HTTP ${res.statusCode}`))
        return
      }
      if (head.length > 0) socket.unshift(head)
      // 请求选项里的 createConnection 只在不用代理池（agent）时生效，而 agent: false 会新建一个
      // 默认 agent 直连目标；所以给这次请求单独建一个 agent，让它的连接就是这条隧道。
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
      Object.assign(agent, {
        createConnection: (): Socket => tls.connect({ socket, servername: host })
      })
      const request = https.request(
        {
          host,
          path: requestPath,
          method: 'GET',
          agent,
          headers: {
            'User-Agent': 'curl/8.0',
            Accept: 'application/json, text/plain, */*',
            Connection: 'close'
          }
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (data: Buffer) => {
            size += data.length
            if (size > MAX_RESPONSE_BYTES) {
              finish(new Error('Response too large'))
              return
            }
            chunks.push(data)
          })
          response.once('end', () => {
            finish(null, {
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8')
            })
          })
          response.once('error', (e) => finish(e))
        }
      )
      request.once('error', (e) =>
        // 隧道在响应之前被关闭，通常是节点连不上目标
        finish(
          (e as NodeJS.ErrnoException).code === 'ECONNRESET'
            ? new Error('Node closed the connection')
            : e
        )
      )
      request.end()
    })
    connect.end()
  })
}
