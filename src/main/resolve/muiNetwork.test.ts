import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateDevice, signRequest } from './plugin/device'
import {
  MuiError,
  importMuiNetworkFile,
  listMuiNetworks,
  nodeIdOf,
  openEnvelope,
  removeMuiNetwork,
  setMuiUsername,
  verifyNetworkDoc
} from './muiNetwork'

const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => true },
  shell: { openExternal: vi.fn() }
}))
vi.mock('../config', () => ({ getControledMihomoConfig: () => Promise.resolve({}) }))
vi.mock('../utils/dirs', () => ({ dataDir: () => dir.path }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }))

dir.path = mkdtempSync(path.join(tmpdir(), 'mui-network-test-'))
afterAll(() => rmSync(dir.path, { recursive: true, force: true }))

// 模拟一个 m-ui 面板：Ed25519 身份，按 m-ui-client/1 签名信封
function panel(name: string, endpoint: string) {
  const keys = generateDevice()
  const descriptor = {
    id: nodeIdOf(keys.pubKeyB64),
    publicKey: keys.pubKeyB64,
    name,
    endpoint,
    revision: 1
  }
  const envelope = (domain: string, value: unknown): string => {
    const payload = Buffer.from(JSON.stringify(value))
    const sig = signRequest(keys.privKeyB64, Buffer.concat([Buffer.from(`${domain}\0`), payload]))
    return `${payload.toString('base64')}.${sig}`
  }
  return { descriptor, envelope }
}

const a = panel('Panel A', 'http://a.example:2053')
const b = panel('Panel B', 'https://b.example')

function networkDoc(signer = a, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: 'm-ui-client/1',
    signer: signer.descriptor,
    nodes: [
      { ...a.descriptor, online: true },
      { ...b.descriptor, online: false }
    ],
    loginUrl: 'http://a.example:2053/panel/client/authorize',
    usernames: ['alice', 'bob'],
    issuedAt: Date.now(),
    ...extra
  }
}

function networkFile(envelope: string): string {
  return JSON.stringify({ magic: 'MUIN', v: 1, spec: 'm-ui-client/1', network: envelope })
}

const trustA = (id: string): string | undefined =>
  id === a.descriptor.id ? a.descriptor.publicKey : undefined

describe('signed envelopes', () => {
  it('derives panel ids like m-ui (first 16 bytes of sha256(pubkey))', () => {
    expect(a.descriptor.id).toMatch(/^[0-9a-f]{32}$/)
    expect(nodeIdOf(a.descriptor.publicKey)).toBe(a.descriptor.id)
  })

  it('opens an envelope signed for the domain and rejects other domains or keys', () => {
    const envelope = a.envelope('m-ui-device-cert-v1', { hello: 1 })
    expect(
      JSON.parse(openEnvelope(envelope, 'm-ui-device-cert-v1', a.descriptor.publicKey).toString())
    ).toEqual({
      hello: 1
    })
    expect(() => openEnvelope(envelope, 'm-ui-client-network-v1', a.descriptor.publicKey)).toThrow(
      MuiError
    )
    expect(() => openEnvelope(envelope, 'm-ui-device-cert-v1', b.descriptor.publicKey)).toThrow(
      '[mui:bad_response]'
    )
    expect(() => openEnvelope('not-an-envelope', 'x', a.descriptor.publicKey)).toThrow(MuiError)
  })
})

describe('network documents', () => {
  it('accepts a document from a trusted panel', () => {
    const doc = verifyNetworkDoc(a.envelope('m-ui-client-network-v1', networkDoc()), trustA)
    expect(doc.nodes.map((n) => n.name)).toEqual(['Panel A', 'Panel B'])
    expect(doc.usernames).toEqual(['alice', 'bob'])
  })

  it('rejects documents from unknown panels or with a forged signer', () => {
    expect(() =>
      verifyNetworkDoc(b.envelope('m-ui-client-network-v1', networkDoc(b)), trustA)
    ).toThrow('[mui:bad_response]')
    // B 签名但自称是 A
    expect(() =>
      verifyNetworkDoc(b.envelope('m-ui-client-network-v1', networkDoc(a)), trustA)
    ).toThrow('[mui:bad_response]')
  })

  it('drops nodes whose id does not match their key', () => {
    const forged = { ...b.descriptor, id: a.descriptor.id.replace(/.$/, '0') }
    const doc = verifyNetworkDoc(
      a.envelope('m-ui-client-network-v1', networkDoc(a, { nodes: [a.descriptor, forged] })),
      trustA
    )
    expect(doc.nodes.map((n) => n.name)).toEqual(['Panel A'])
  })
})

describe('network file import', () => {
  it('rejects files that are not m-ui network files', async () => {
    await expect(importMuiNetworkFile('{"magic":"X"}')).rejects.toThrow('[mui:invalid_file]')
    await expect(importMuiNetworkFile('<html>')).rejects.toThrow('[mui:invalid_file]')
    const envelope = a.envelope('m-ui-client-network-v1', networkDoc())
    const tampered = envelope.replace(/^.{8}/, 'AAAAAAAA')
    await expect(importMuiNetworkFile(networkFile(tampered))).rejects.toThrow(MuiError)
  })

  it('imports the panels, usernames and login address, then validates the username', async () => {
    const network = await importMuiNetworkFile(
      networkFile(a.envelope('m-ui-client-network-v1', networkDoc()))
    )
    expect(network).toMatchObject({
      id: a.descriptor.id,
      name: 'Panel A',
      loginUrl: 'http://a.example:2053/panel/client/authorize',
      loggedIn: false,
      username: 'alice'
    })
    expect(network.nodes.find((n) => n.id === a.descriptor.id)?.meshOnline).toBe(true)
    expect(network.nodes.find((n) => n.id === b.descriptor.id)?.meshOnline).toBe(false)

    expect((await setMuiUsername(network.id, 'bob')).username).toBe('bob')
    await expect(setMuiUsername(network.id, 'mallory')).rejects.toThrow('[mui:not_found]')

    const listed = await listMuiNetworks()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('cert')
    expect(listed[0]).not.toHaveProperty('devicePrivEnc')

    await removeMuiNetwork(network.id)
    expect(await listMuiNetworks()).toEqual([])
  })
})
