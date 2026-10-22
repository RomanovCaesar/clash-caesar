import { describe, expect, it } from 'vitest'
import { isOverseasNameserver, nameserverHost, needsRespectRulesHint } from './dns-hint'

describe('nameserver host', () => {
  it('handles the usual mihomo nameserver forms', () => {
    expect(nameserverHost('https://dns.google/dns-query')).toBe('dns.google')
    expect(nameserverHost('tls://1.1.1.1:853')).toBe('1.1.1.1')
    expect(nameserverHost('quic://[2606:4700:4700::1111]:853')).toBe('2606:4700:4700::1111')
    expect(nameserverHost('8.8.8.8#DIRECT')).toBe('8.8.8.8')
    expect(nameserverHost('2001:4860:4860::8888')).toBe('2001:4860:4860::8888')
    expect(nameserverHost('  223.5.5.5  ')).toBe('223.5.5.5')
  })

  it('tells overseas resolvers from domestic ones', () => {
    expect(isOverseasNameserver('https://1.1.1.1/dns-query')).toBe(true)
    expect(isOverseasNameserver('https://doh.pub/dns-query')).toBe(false)
    expect(isOverseasNameserver('223.5.5.5')).toBe(false)
  })
})

describe('respect-rules hint', () => {
  const overseas = ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query', '8.8.8.8']

  it('warns when every upstream is overseas and DNS ignores the rules', () => {
    expect(needsRespectRulesHint(overseas, false)).toBe(true)
  })

  it('stays quiet once respect-rules is on', () => {
    expect(needsRespectRulesHint(overseas, true)).toBe(false)
  })

  it('stays quiet when a domestic resolver is in the list', () => {
    expect(needsRespectRulesHint([...overseas, 'https://doh.pub/dns-query'], false)).toBe(false)
  })

  it('ignores an empty list', () => {
    expect(needsRespectRulesHint(['', ' '], false)).toBe(false)
  })
})
