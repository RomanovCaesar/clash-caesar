import { describe, expect, it, vi } from 'vitest'
import { maskIp, parseIpinfo, parseIpipProvince } from '../../shared/nodeGeo'
import { addNodeGeoProbes, isChannelDown, isGeoFresh, isProbeGroupName } from './nodeGeo'

const appConfig = vi.hoisted(() => ({ nodeGeoEnabled: true as boolean | undefined }))

vi.mock('../config', () => ({ getAppConfig: () => Promise.resolve(appConfig) }))
vi.mock('../core/factory', () => ({ getRuntimeConfig: vi.fn() }))
vi.mock('../core/mihomoApi', () => ({ mihomoChangeProxy: vi.fn(), mihomoProxyProviders: vi.fn() }))
vi.mock('../utils/dirs', () => ({ dataDir: () => '' }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../window', () => ({ mainWindow: undefined }))

describe('ipinfo response', () => {
  it('reads the exit IP, country and organisation', () => {
    expect(
      parseIpinfo({ ip: '112.104.1.2', country: 'tw', org: 'AS4780 Digital United', loc: '1,2' })
    ).toEqual({ ip: '112.104.1.2', country: 'TW', org: 'AS4780 Digital United' })
  })

  it('keeps the IP when the country is missing (for example a bogon)', () => {
    expect(parseIpinfo({ ip: '10.0.0.1', bogon: true })).toEqual({ ip: '10.0.0.1', country: '' })
  })

  it('surfaces ipinfo errors', () => {
    expect(() => parseIpinfo({ error: { message: 'Rate limit exceeded' } })).toThrow(
      'Rate limit exceeded'
    )
    expect(() => parseIpinfo('<html>')).toThrow()
  })
})

describe('myip.ipip.net province', () => {
  it.each([
    ['当前 IP：1.2.3.4  来自于：中国 广东 深圳  电信\n', '广东'],
    ['当前 IP：1.2.3.4  来自于：中国 北京 北京  联通', '北京'],
    ['当前 IP：1.2.3.4  来自于：中国 广西壮族自治区 南宁  移动', '广西'],
    ['当前 IP：1.2.3.4  来自于：中国 浙江省 杭州  阿里云', '浙江']
  ])('reads the province from %s', (text, province) => {
    expect(parseIpipProvince(text)).toBe(province)
  })

  it('ignores exits outside mainland China and unknown provinces', () => {
    expect(parseIpipProvince('当前 IP：1.2.3.4  来自于：加拿大 艾伯塔省 埃德蒙顿')).toBeUndefined()
    expect(parseIpipProvince('当前 IP：1.2.3.4  来自于：中国 中国')).toBeUndefined()
    expect(parseIpipProvince('error')).toBeUndefined()
  })
})

describe('exit IP privacy', () => {
  it('keeps only the first two parts', () => {
    expect(maskIp('112.104.33.44')).toBe('112.104.*.*')
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:*:*')
  })
})

describe('cache freshness', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const hour = 60 * 60 * 1000
  const geo = (patch: Partial<INodeGeo>): INodeGeo => ({
    server: 'a.com:443',
    country: 'JP',
    updated: now,
    ...patch
  })

  it('reuses a successful lookup for 24 hours', () => {
    expect(isGeoFresh(geo({ updated: now - 23 * hour }), 'a.com:443', now)).toBe(true)
    expect(isGeoFresh(geo({ updated: now - 25 * hour }), 'a.com:443', now)).toBe(false)
  })

  it('retries a failed lookup after an hour', () => {
    expect(
      isGeoFresh(geo({ error: 'timeout', updated: now - 30 * 60 * 1000 }), 'a.com:443', now)
    ).toBe(true)
    expect(isGeoFresh(geo({ error: 'timeout', updated: now - 2 * hour }), 'a.com:443', now)).toBe(
      false
    )
  })

  it('looks the node up again when its server changed', () => {
    expect(isGeoFresh(geo({}), 'b.com:443', now)).toBe(false)
    expect(isGeoFresh(undefined, 'a.com:443', now)).toBe(false)
  })
})

describe('probe channels in the core config', () => {
  it('adds hidden probe groups and loopback listeners bound to them', async () => {
    appConfig.nodeGeoEnabled = true
    const profile = {
      'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['DIRECT'] }],
      listeners: [{ name: 'mine', type: 'socks', port: 1080 }]
    } as unknown as IMihomoConfig
    await addNodeGeoProbes(profile)
    const doc = profile as unknown as Record<string, Record<string, unknown>[]>
    const probes = doc['proxy-groups'].filter((g) => isProbeGroupName(g.name as string))
    const listeners = doc.listeners.filter((l) => isProbeGroupName(l.name as string))
    expect(doc['proxy-groups'][0].name).toBe('Proxy')
    expect(doc.listeners[0].name).toBe('mine')
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((g) => g.hidden === true && g['include-all'] === true)).toBe(true)
    expect(listeners).toHaveLength(probes.length)
    listeners.forEach((l, i) => {
      expect(l).toMatchObject({ listen: '127.0.0.1', proxy: probes[i].name, type: 'mixed' })
      expect(l.port).toBeGreaterThan(0)
    })
  })

  // 改设置只会热更新内核、不重新加载配置，内核一直监听最初的端口
  it('keeps the same probe ports every time the config is generated', async () => {
    const portsOf = async (): Promise<unknown[]> => {
      const profile = { 'proxy-groups': [] } as unknown as IMihomoConfig
      await addNodeGeoProbes(profile)
      return (
        (profile as unknown as Record<string, Record<string, unknown>[]>).listeners ?? []
      ).map((l) => l.port)
    }
    const first = await portsOf()
    expect(first.length).toBeGreaterThan(0)
    expect(await portsOf()).toEqual(first)
  })

  it('adds nothing when the lookup is turned off', async () => {
    appConfig.nodeGeoEnabled = false
    const profile = { 'proxy-groups': [] } as unknown as IMihomoConfig
    await addNodeGeoProbes(profile)
    expect(profile['proxy-groups']).toEqual([])
    expect((profile as unknown as Record<string, unknown>).listeners).toBeUndefined()
  })
})

describe('probe channel failures', () => {
  it('treats a refused loopback probe port as a channel problem, not a node failure', () => {
    expect(
      isChannelDown(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:50411'), { code: 'ECONNREFUSED' })
      )
    ).toBe(true)
    expect(isChannelDown('connect ECONNREFUSED 127.0.0.1:50412')).toBe(true)
  })

  it('keeps real node failures', () => {
    expect(isChannelDown(new Error('Node closed the connection'))).toBe(false)
    expect(isChannelDown(new Error('ipinfo HTTP 502'))).toBe(false)
  })
})
