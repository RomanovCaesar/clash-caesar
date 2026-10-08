import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify
} from 'crypto'

export const OP_CONFIG = 1
export const OP_REVOKE = 2

// Fixed DER prefix for an Ed25519 PKCS#8 key; the 32-byte raw seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface DeviceKeys {
  deviceId: string
  privKeyB64: string // raw 32-byte seed, base64
  pubKeyB64: string // raw 32-byte public key, base64
}

export function generateDevice(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  const seed = privDer.subarray(privDer.length - 32)
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return {
    deviceId: randomUUID(),
    privKeyB64: seed.toString('base64'),
    pubKeyB64: Buffer.from(pubJwk.x, 'base64url').toString('base64')
  }
}

export function buildSignInput(
  op: number,
  deviceId: string,
  nonceId: string,
  nonce: Buffer,
  ts: number
): Buffer {
  const did = Buffer.from(deviceId, 'utf-8')
  const nid = Buffer.from(nonceId, 'utf-8')
  if (did.length > 255 || nid.length > 255) throw new Error('deviceId/nonceId too long')
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

export function signRequest(privKeyB64: string, input: Buffer): string {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privKeyB64, 'base64')])
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  return sign(null, input, key).toString('base64')
}

export function verifyRequest(pubKeyB64: string, input: Buffer, sigB64: string): boolean {
  const x = Buffer.from(pubKeyB64, 'base64').toString('base64url')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  return verify(null, input, key, Buffer.from(sigB64, 'base64'))
}
