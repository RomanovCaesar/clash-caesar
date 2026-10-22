import { createRequire } from 'module'
import { Readable } from 'stream'
import zlib from 'zlib'
import { describe, expect, it } from 'vitest'
import { nodeHasBrotliFix, patchZlib, workerSourceWithBrotliGuard } from './brotliGuard'

const realRequire = createRequire(import.meta.url)

// 装到一个替身 zlib 上，不动测试进程自己的 zlib。属性描述符照搬 Node：
// createBrotliDecompress 是不可写、可配置的，直接赋值会被静默忽略
function patchedZlib(): typeof zlib {
  const fake = {} as typeof zlib
  for (const name of [
    'BrotliDecompress',
    'createBrotliDecompress',
    'brotliDecompress',
    'brotliDecompressSync'
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(zlib, name)
    if (descriptor) Object.defineProperty(fake, name, descriptor)
  }
  patchZlib((id) => (id === 'zlib' ? fake : realRequire(id)))
  return fake
}

const sample = Buffer.from(
  'proxies:\n  - { name: HK, type: vless, server: a.example.com }\n'.repeat(500)
)
const compressed = zlib.brotliCompressSync(sample)

describe('fixed Node.js versions (CVE-2026-111497)', () => {
  it('recognises the patched releases', () => {
    expect(nodeHasBrotliFix('24.22.1')).toBe(true)
    expect(nodeHasBrotliFix('24.23.0')).toBe(true)
    expect(nodeHasBrotliFix('22.23.4')).toBe(true)
    expect(nodeHasBrotliFix('26.12.1')).toBe(true)
    expect(nodeHasBrotliFix('27.0.0')).toBe(true)
  })

  it('treats older releases as vulnerable', () => {
    expect(nodeHasBrotliFix('24.22.0')).toBe(false)
    expect(nodeHasBrotliFix('24.21.0')).toBe(false)
    expect(nodeHasBrotliFix('22.23.3')).toBe(false)
    expect(nodeHasBrotliFix('26.12.0')).toBe(false)
    expect(nodeHasBrotliFix('20.19.0')).toBe(false)
  })
})

describe('JavaScript Brotli decoder in place of zlib', () => {
  const fake = patchedZlib()

  it('replaces every Brotli decompression entry point', () => {
    expect(fake.createBrotliDecompress).not.toBe(zlib.createBrotliDecompress)
    expect(fake.brotliDecompress).not.toBe(zlib.brotliDecompress)
    expect(fake.brotliDecompressSync).not.toBe(zlib.brotliDecompressSync)
    expect(fake.BrotliDecompress).not.toBe(zlib.BrotliDecompress)
  })

  it('decompresses synchronously', () => {
    expect(fake.brotliDecompressSync(compressed).equals(sample)).toBe(true)
    expect(fake.brotliDecompressSync(new Uint8Array(compressed)).equals(sample)).toBe(true)
  })

  it('decompresses with a callback', async () => {
    const out = await new Promise<Buffer>((resolve, reject) =>
      fake.brotliDecompress(compressed, (err, result) => (err ? reject(err) : resolve(result)))
    )
    expect(out.equals(sample)).toBe(true)
  })

  it('decompresses a stream split into many chunks', async () => {
    const chunks = Array.from({ length: Math.ceil(compressed.length / 7) }, (_, i) =>
      compressed.subarray(i * 7, i * 7 + 7)
    )
    const parts: Buffer[] = []
    await new Promise<void>((resolve, reject) =>
      Readable.from(chunks)
        .pipe(fake.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH }))
        .on('data', (c: Buffer) => parts.push(c))
        .on('end', () => resolve())
        .on('error', reject)
    )
    expect(Buffer.concat(parts).equals(sample)).toBe(true)
  })

  it('reports corrupt data as an error instead of crashing', async () => {
    expect(() => fake.brotliDecompressSync(Buffer.from([1, 2, 3, 4, 5]))).toThrow()
    const error = await new Promise<Error | null>((resolve) => {
      const stream = fake.createBrotliDecompress()
      stream.on('error', resolve).on('end', () => resolve(null))
      stream.resume()
      stream.end(Buffer.from([1, 2, 3, 4, 5]))
    })
    expect(error).toBeInstanceOf(Error)
  })
})

describe('Sub-Store worker source', () => {
  it('loads the bundle after installing the decoder when Node is vulnerable', () => {
    const source = workerSourceWithBrotliGuard('C:\\data\\sub-store.bundle.cjs')
    expect(source.endsWith('require("C:\\\\data\\\\sub-store.bundle.cjs")')).toBe(true)
    if (!nodeHasBrotliFix()) expect(source).toContain('makeBrotliDecode')
  })
})
