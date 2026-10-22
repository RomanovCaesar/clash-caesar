import { createRequire, syncBuiltinESMExports } from 'module'
import decoderSource from './brotli/decode.js?raw'

// CVE-2026-111497：Node.js 的 Brotli 解码器（zlib）有越界写入，解压攻击者构造的数据可能导致远程代码执行。
// 订阅服务器、Sub-Store 拉取的远程资源都可能是攻击者控制的。在内置 Node 修复之前，把 zlib 的 Brotli
// 解压换成 Google 官方的纯 JavaScript 解码器（utils/brotli/decode.js），接口和行为保持兼容。
// 修复版本见 https://nodejs.org/en/blog/vulnerability/october-2026-security-releases

const FIXED_VERSIONS: Record<number, [number, number]> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1]
}

export function nodeHasBrotliFix(version: string = process.versions.node): boolean {
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10))
  if (major > 26) return true
  const fixed = FIXED_VERSIONS[major]
  // 未列出的旧主版本都已停止维护，没有修复
  if (!fixed) return false
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1])
}

// 安装到 zlib 上的替换实现。写成源码文本，主进程和 Sub-Store 的 worker 线程用同一份。
// 运行环境里需要有 makeBrotliDecode（来自 decoderSource）和 require。
const PATCH_SOURCE = `
;(function () {
  const zlib = require('zlib')
  const { Transform } = require('stream')
  const decode = makeBrotliDecode()
  const toBuffer = (input) => {
    if (Buffer.isBuffer(input)) return input
    if (typeof input === 'string') return Buffer.from(input)
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    return Buffer.from(input)
  }
  const decompress = (input) => {
    const data = toBuffer(input)
    const out = decode(new Int8Array(data.buffer, data.byteOffset, data.byteLength))
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
  }
  // 流式接口：收齐数据后一次解码（订阅、图标这类响应都不大）
  class BrotliDecompress extends Transform {
    constructor(options) {
      super(options && options.highWaterMark ? { highWaterMark: options.highWaterMark } : {})
      this._chunks = []
    }
    _transform(chunk, _encoding, callback) {
      this._chunks.push(toBuffer(chunk))
      callback()
    }
    _flush(callback) {
      let out
      try {
        out = decompress(Buffer.concat(this._chunks))
      } catch (e) {
        callback(e)
        return
      }
      this._chunks = []
      callback(null, out)
    }
  }
  // Node 把 createBrotliDecompress 定义成不可写（但可配置），直接赋值会被静默忽略
  const replace = (name, value) =>
    Object.defineProperty(zlib, name, { value, writable: true, enumerable: true, configurable: true })
  replace('BrotliDecompress', BrotliDecompress)
  replace('createBrotliDecompress', (options) => new BrotliDecompress(options))
  replace('brotliDecompressSync', (input) => decompress(input))
  replace('brotliDecompress', (input, options, callback) => {
    if (typeof options === 'function') callback = options
    let out, error = null
    try {
      out = decompress(input)
    } catch (e) {
      error = e
    }
    process.nextTick(() => callback(error, out))
  })
})()
`

let installed = false

// 主进程：在任何模块用到 zlib 之前调用。返回是否装上了替换实现。
export function installBrotliGuard(): boolean {
  if (installed || nodeHasBrotliFix()) return installed
  // 主进程打包成 ES 模块，没有全局 require
  patchZlib(createRequire(import.meta.url))
  // ES 模块里 `import { createBrotliDecompress } from 'zlib'` 拿到的具名导出不会自动跟着变，同步一次
  syncBuiltinESMExports()
  installed = true
  return true
}

// 把替换实现装到 require('zlib') 拿到的对象上；单独导出供测试传入替身
export function patchZlib(requireFn: (id: string) => unknown): void {
  new Function('require', `${decoderSource}\n${PATCH_SOURCE}`)(requireFn)
}

// Sub-Store 的 worker：以 eval 方式启动，先装替换实现再加载 Sub-Store 的 bundle
export function workerSourceWithBrotliGuard(scriptPath: string): string {
  const load = `require(${JSON.stringify(scriptPath)})`
  if (nodeHasBrotliFix()) return load
  return `${decoderSource}\n${PATCH_SOURCE}\n${load}`
}
