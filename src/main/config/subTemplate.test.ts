import { describe, expect, it, vi } from 'vitest'
import { parse } from '../utils/yaml'
import {
  applySubTemplate,
  builtinSubTemplateYAML,
  cleanSubTemplate,
  formatTemplateRule,
  parseSubTemplate,
  parseTemplateRule,
  resolveSubTemplateId,
  subTemplateKey
} from './subTemplate'

vi.mock('../utils/dirs', () => ({
  subTemplateConfigPath: () => '',
  subTemplatePath: () => ''
}))
vi.mock('../utils/chromeRequest', () => ({ get: vi.fn() }))
vi.mock('./controledMihomo', () => ({ getControledMihomoConfig: vi.fn() }))

type Doc = Record<string, unknown>
type Group = Record<string, unknown>

const config = (patch: Partial<ISubTemplateConfig> = {}): ISubTemplateConfig => ({
  enabled: true,
  global: 'builtin',
  variant: 'cn',
  overrideSettings: false,
  items: [{ id: 'mine', name: 'Mine', updated: 1 }],
  ...patch
})

describe('built-in template', () => {
  it.each(['cn', 'ru', 'ir'] as const)('the %s variant is a valid template', (variant) => {
    const doc = parseSubTemplate(builtinSubTemplateYAML(variant))
    const groups = doc['proxy-groups'] as Group[]
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g['include-all-proxies'] === true)).toBe(true)
    const rules = doc.rules as string[]
    expect(rules[rules.length - 1]).toBe(`MATCH,${groups[0].name}`)
  })

  it('only the country specific direct rules differ between variants', () => {
    const cn = parseSubTemplate(builtinSubTemplateYAML('cn')).rules as string[]
    const ru = parseSubTemplate(builtinSubTemplateYAML('ru')).rules as string[]
    expect(cn).toContain('GEOSITE,cn,DIRECT')
    expect(ru).toContain('GEOSITE,category-ru,DIRECT')
    expect(ru).not.toContain('GEOSITE,cn,DIRECT')
  })
})

describe('rule parsing', () => {
  it.each([
    'DOMAIN-SUFFIX,example.com,Proxy',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT',
    'OR,((DOMAIN,a.com),(NOT,((DOMAIN,b.com)))),Proxy',
    'MATCH,Proxy'
  ])('round-trips %s', (rule) => {
    expect(formatTemplateRule(parseTemplateRule(rule))).toBe(rule)
  })

  it('reads the target of a logical rule outside its parentheses', () => {
    expect(parseTemplateRule('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT').target).toBe('REJECT')
  })
})

describe('import cleaning', () => {
  const subscription = `# from my airport, nodes: HK-01
proxies:
  - { name: HK-01, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x }
  - { name: JP-01, type: ss, server: 2.2.2.2, port: 443, cipher: aes-128-gcm, password: x }
proxy-providers:
  airport: { type: http, url: https://example.com/sub, path: ./a.yaml }
dns:
  enable: true
proxy-groups:
  - name: Select
    type: select
    proxies: [Auto, HK-01, JP-01, DIRECT]
  - name: Auto
    type: url-test
    use: [airport]
  - name: Streaming
    type: select
    proxies: [Select, DIRECT]
rules:
  - DOMAIN-SUFFIX,netflix.com,Streaming
  - DOMAIN-SUFFIX,special.com,HK-01 # pinned node
  - MATCH,Select
`

  it('strips nodes, providers and comments and marks the node groups', () => {
    const { content, stats } = cleanSubTemplate(subscription)
    expect(content).not.toContain('HK-01')
    expect(content).not.toContain('airport')
    expect(content).not.toContain('#')
    const doc = parse<Doc>(content)
    expect(doc.proxies).toBeUndefined()
    expect(doc['proxy-providers']).toBeUndefined()
    expect(doc.dns).toEqual({ enable: true })
    const [select, auto, streaming] = doc['proxy-groups'] as Group[]
    expect(select).toMatchObject({ proxies: ['Auto', 'DIRECT'], 'include-all-proxies': true })
    expect(auto['include-all-proxies']).toBe(true)
    expect(auto.use).toBeUndefined()
    expect(streaming['include-all-proxies']).toBeUndefined()
    expect(doc.rules).toContain('DOMAIN-SUFFIX,special.com,Select')
    expect(stats).toEqual({
      removedProxies: 2,
      removedProviders: 1,
      nodeGroups: 2,
      groups: 3,
      rules: 3,
      retargetedRules: 1
    })
  })

  it('rejects a document without proxy groups or rules', () => {
    expect(() => cleanSubTemplate('rules:\n  - MATCH,DIRECT\n')).toThrow('proxy-groups')
    expect(() =>
      cleanSubTemplate('proxy-groups:\n  - { name: A, type: select, proxies: [DIRECT] }\n')
    ).toThrow('rules')
  })

  it('refuses a stored template that still references a node', () => {
    const bad = `proxy-groups:
  - { name: A, type: select, proxies: [HK-01] }
rules:
  - MATCH,A
`
    expect(() => parseSubTemplate(bad)).toThrow('HK-01')
  })
})

describe('applying a template', () => {
  const template = parseSubTemplate(`ipv6: true
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT], include-all-proxies: true }
rule-providers:
  ads: { type: http, behavior: domain, url: https://example.com/ads.yaml, path: ./ads.yaml }
rules:
  - RULE-SET,ads,REJECT
  - MATCH,Proxy
`)
  const subscription = {
    ipv6: false,
    dns: { enable: true },
    proxies: [{ name: 'HK-01', type: 'ss' }],
    'proxy-providers': { airport: { type: 'http' } },
    'proxy-groups': [{ name: 'Old', type: 'select', proxies: ['HK-01'] }],
    'rule-providers': { old: { type: 'http' } },
    'sub-rules': { old: ['MATCH,DIRECT'] },
    rules: ['MATCH,Old']
  } as unknown as IMihomoConfig

  it('replaces only groups and rules by default and keeps the nodes', () => {
    const result = applySubTemplate(subscription, template, false) as unknown as Doc
    expect(result.ipv6).toBe(false)
    expect(result.dns).toEqual({ enable: true })
    expect(result.proxies).toEqual([{ name: 'HK-01', type: 'ss' }])
    expect(result['proxy-providers']).toEqual({ airport: { type: 'http' } })
    expect(result.rules).toEqual(['RULE-SET,ads,REJECT', 'MATCH,Proxy'])
    expect(Object.keys(result['rule-providers'] as Doc)).toEqual(['ads'])
    expect(result['sub-rules']).toBeUndefined()
    // include-all also pulls in nodes from the subscription's proxy-providers
    expect((result['proxy-groups'] as Group[])[0]).toEqual({
      name: 'Proxy',
      type: 'select',
      proxies: ['DIRECT'],
      'include-all': true
    })
  })

  it('also takes the other settings from the template when asked to', () => {
    const result = applySubTemplate(subscription, template, true) as unknown as Doc
    expect(result.ipv6).toBe(true)
    expect(result.dns).toBeUndefined()
    expect(result.proxies).toEqual([{ name: 'HK-01', type: 'ss' }])
    expect(result['proxy-providers']).toEqual({ airport: { type: 'http' } })
  })

  it('never modifies the subscription or the template it was given', () => {
    const before = JSON.stringify([subscription, template])
    applySubTemplate(subscription, template, false)
    applySubTemplate(subscription, template, true)
    expect(JSON.stringify([subscription, template])).toBe(before)
  })
})

describe('which template a subscription uses', () => {
  it('uses nothing while the feature is off', () => {
    expect(resolveSubTemplateId({ subTemplate: 'mine' }, config({ enabled: false }))).toBe(
      undefined
    )
  })

  it("prefers the subscription's own choice over the global template", () => {
    expect(resolveSubTemplateId({}, config())).toBe('builtin')
    expect(resolveSubTemplateId({ subTemplate: 'mine' }, config())).toBe('mine')
    expect(resolveSubTemplateId({ subTemplate: 'none' }, config())).toBeUndefined()
  })

  it('falls back to the global template when the chosen one was deleted', () => {
    expect(resolveSubTemplateId({ subTemplate: 'gone' }, config())).toBe('builtin')
  })

  it('applies to chosen subscriptions only when the global template is none', () => {
    expect(resolveSubTemplateId({}, config({ global: '' }))).toBeUndefined()
    expect(resolveSubTemplateId({ subTemplate: 'mine' }, config({ global: '' }))).toBe('mine')
  })

  it('changes its key whenever the effective template changes', () => {
    const base = subTemplateKey({}, config())
    expect(subTemplateKey({}, config({ variant: 'ru' }))).not.toBe(base)
    expect(subTemplateKey({}, config({ overrideSettings: true }))).not.toBe(base)
    expect(subTemplateKey({}, config({ enabled: false }))).not.toBe(base)
    expect(subTemplateKey({ subTemplate: 'mine' }, config())).not.toBe(base)
    const edited = config({ items: [{ id: 'mine', name: 'Mine', updated: 2 }] })
    expect(subTemplateKey({ subTemplate: 'mine' }, edited)).not.toBe(
      subTemplateKey({ subTemplate: 'mine' }, config())
    )
    // a template the subscription does not use does not affect it
    expect(subTemplateKey({}, edited)).toBe(base)
  })
})
