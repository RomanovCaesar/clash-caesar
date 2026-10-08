import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createPrivateKey, createPublicKey, sign } from 'crypto'

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function keyFromSeed(seed) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
}
function pubRaw(priv) {
  const jwk = createPublicKey(priv).export({ format: 'jwk' })
  return Buffer.from(jwk.x, 'base64url')
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

const cases = [
  {
    op: 1,
    deviceId: '11111111-1111-4111-8111-111111111111',
    nonceId: 'nonce-1',
    seedByte: 1,
    nonceByte: 0xaa,
    ts: 1700000000000
  },
  {
    op: 2,
    deviceId: '22222222-2222-4222-8222-222222222222',
    nonceId: 'nonce-2',
    seedByte: 2,
    nonceByte: 0xbb,
    ts: 1700000001234
  }
]

const out = cases.map((c) => {
  const seed = Buffer.alloc(32, c.seedByte)
  const nonce = Buffer.alloc(32, c.nonceByte)
  const priv = keyFromSeed(seed)
  const input = buildInput(c.op, c.deviceId, c.nonceId, nonce, c.ts)
  return {
    op: c.op,
    deviceId: c.deviceId,
    nonceId: c.nonceId,
    privSeedB64: seed.toString('base64'),
    pubKeyB64: pubRaw(priv).toString('base64'),
    nonceB64: nonce.toString('base64'),
    ts: c.ts,
    inputHex: input.toString('hex'),
    sigB64: sign(null, input, priv).toString('base64')
  }
})

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'main',
  'resolve',
  'plugin',
  '__fixtures__'
)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'sign-vectors.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote', out.length, 'sign vectors')
