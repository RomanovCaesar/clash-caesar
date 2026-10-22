import { describe, expect, it, vi } from 'vitest'
import { isSafeExternalUrl } from './navigation'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./logger', () => ({ mainWindowLogger: { warn: vi.fn() } }))

describe('external links', () => {
  it('opens web pages', () => {
    expect(isSafeExternalUrl('https://github.com/RomanovCaesar/clash-caesar')).toBe(true)
    expect(isSafeExternalUrl('http://panel.example:2053/')).toBe(true)
  })

  it('refuses anything Windows would run or hand to a system component', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'file://attacker.example/share/payload.exe',
      '\\\\attacker.example\\share\\payload.exe',
      'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(1)',
      'clash-caesar://install-config?url=x',
      ''
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
  })

  it('refuses values that are not strings', () => {
    expect(isSafeExternalUrl(undefined)).toBe(false)
    expect(isSafeExternalUrl(['https://example.com'])).toBe(false)
  })
})
