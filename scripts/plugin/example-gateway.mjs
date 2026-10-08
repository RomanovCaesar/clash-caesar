// Minimal demo gateway — PROTOCOL REFERENCE ONLY, not runnable against the real client.
// It serves plain HTTP on loopback and its /.well-known advertises an https://127.0.0.1 origin,
// both of which the hardened client deliberately REFUSES (https-only + no private/loopback host).
// Use it to read the exact request/response shapes and the Ed25519 verify logic; for an end-to-end
// demo against the client you must front it with real HTTPS on a public host.
// NOT production — no real OAuth, in-memory device store.
// Run (shape inspection / curl only): node scripts/plugin/example-gateway.mjs  (127.0.0.1:8788)
import http from 'http'
import { randomBytes, createPublicKey, verify } from 'crypto'

const devices = new Map() // deviceId -> pubKey(raw base64)
const nonces = new Map() // nonceId -> { deviceId, nonce(b64), exp }

const CLASH =
  'proxies:\n  - {name: demo, type: ss, server: 1.1.1.1, port: 8388, cipher: aes-128-gcm, password: x}\n'

function pubKeyFromRaw(b64) {
  const x = Buffer.from(b64, 'base64').toString('base64url')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
}
function buildInput(op, deviceId, nonceId, nonce, ts) {
  const did = Buffer.from(deviceId, 'utf-8')
  const nid = Buffer.from(nonceId, 'utf-8')
  const tsB = Buffer.alloc(8)
  tsB.writeBigUInt64BE(BigInt(ts))
  return Buffer.concat([
    Buffer.from('CPX2', 'ascii'),
    Buffer.from([op]),
    Buffer.from([did.length]),
    did,
    Buffer.from([nid.length]),
    nid,
    nonce,
    tsB
  ])
}
function readBody(req) {
  return new Promise((resolve) => {
    const c = []
    req.on('data', (d) => c.push(d))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(c).toString('utf-8')))
      } catch {
        resolve({})
      }
    })
  })
}
function verifySigned(op, b) {
  const rec = nonces.get(b.nonceId)
  if (!rec || rec.deviceId !== b.deviceId || rec.nonce !== b.nonce || Date.now() > rec.exp)
    return false
  const pub = devices.get(b.deviceId)
  if (!pub) return false
  const ok = verify(
    null,
    buildInput(op, b.deviceId, b.nonceId, Buffer.from(b.nonce, 'base64'), b.ts),
    pubKeyFromRaw(pub),
    Buffer.from(b.sig, 'base64')
  )
  if (ok) nonces.delete(b.nonceId) // consume
  return ok
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.url === '/.well-known/cpx-gateway') {
    return json(200, {
      spec: 'cpx-plugin/2',
      gateway: 'https://127.0.0.1:8788',
      endpoints: {
        enroll: '/enroll',
        challenge: '/challenge',
        config: '/config',
        revoke: '/revoke'
      }
    })
  }
  const b = await readBody(req)
  if (req.url === '/enroll') {
    devices.set(b.deviceId, b.devicePubKey) // demo: trust the code, skip real PKCE check
    return json(200, { ok: true })
  }
  if (req.url === '/challenge') {
    const nonceId = randomBytes(8).toString('hex')
    const nonce = randomBytes(32).toString('base64')
    nonces.set(nonceId, { deviceId: b.deviceId, nonce, exp: Date.now() + 60000 })
    return json(200, { nonceId, nonce, exp: 60 })
  }
  if (req.url === '/config') {
    if (!verifySigned(1, b)) return json(403, { error: 'bad signature' })
    res.writeHead(200, { 'content-type': 'text/yaml' })
    return res.end(CLASH)
  }
  if (req.url === '/revoke') {
    if (!verifySigned(2, b)) return json(403, { error: 'bad signature' })
    devices.delete(b.deviceId)
    return json(200, { ok: true })
  }
  json(404, { error: 'not found' })
})
server.listen(8788, '127.0.0.1', () => console.log('demo gateway on http://127.0.0.1:8788'))
