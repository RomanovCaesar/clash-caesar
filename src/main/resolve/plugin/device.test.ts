import { describe, it, expect } from 'vitest'
import {
  generateDevice,
  buildSignInput,
  signRequest,
  verifyRequest,
  OP_CONFIG,
  OP_REVOKE
} from './device'

describe('device', () => {
  it('generates a UUID deviceId and 32-byte raw keys (base64)', () => {
    const d = generateDevice()
    expect(d.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(Buffer.from(d.privKeyB64, 'base64')).toHaveLength(32)
    expect(Buffer.from(d.pubKeyB64, 'base64')).toHaveLength(32)
  })

  it('sign/verify round-trips', () => {
    const d = generateDevice()
    const nonce = Buffer.alloc(32, 7)
    const input = buildSignInput(OP_CONFIG, d.deviceId, 'n1', nonce, 1700000000000)
    const sig = signRequest(d.privKeyB64, input)
    expect(Buffer.from(sig, 'base64')).toHaveLength(64)
    expect(verifyRequest(d.pubKeyB64, input, sig)).toBe(true)
  })

  it('verify fails on tampered input', () => {
    const d = generateDevice()
    const nonce = Buffer.alloc(32, 7)
    const a = buildSignInput(OP_CONFIG, d.deviceId, 'n1', nonce, 1700000000000)
    const b = buildSignInput(OP_REVOKE, d.deviceId, 'n1', nonce, 1700000000000)
    const sig = signRequest(d.privKeyB64, a)
    expect(verifyRequest(d.pubKeyB64, b, sig)).toBe(false)
  })

  it('builds the canonical input deterministically (spec §7)', () => {
    const nonce = Buffer.alloc(32, 0xab)
    const input = buildSignInput(OP_CONFIG, 'dev', 'nid', nonce, 1)
    // "CPX2" | op(1) | len(3)+"dev" | len(3)+"nid" | 32B nonce | uint64_be(1)
    const expected = Buffer.concat([
      Buffer.from('CPX2', 'ascii'),
      Buffer.from([1]),
      Buffer.from([3]),
      Buffer.from('dev', 'utf-8'),
      Buffer.from([3]),
      Buffer.from('nid', 'utf-8'),
      nonce,
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])
    ])
    expect(input.equals(expected)).toBe(true)
  })
})
