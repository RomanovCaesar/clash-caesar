import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { buildSignInput, signRequest, verifyRequest } from './device'

interface Vector {
  op: number
  deviceId: string
  nonceId: string
  privSeedB64: string
  pubKeyB64: string
  nonceB64: string
  ts: number
  inputHex: string
  sigB64: string
}

const vectors: Vector[] = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'sign-vectors.json'), 'utf-8')
)

describe('cross-language Ed25519 sign vectors', () => {
  it('device.ts reproduces each recorded canonical input + signature', () => {
    expect(vectors.length).toBeGreaterThan(0)
    for (const v of vectors) {
      const nonce = Buffer.from(v.nonceB64, 'base64')
      const input = buildSignInput(v.op, v.deviceId, v.nonceId, nonce, v.ts)
      expect(input.toString('hex')).toBe(v.inputHex)
      expect(signRequest(v.privSeedB64, input)).toBe(v.sigB64)
      expect(verifyRequest(v.pubKeyB64, input, v.sigB64)).toBe(true)
    }
  })
})
