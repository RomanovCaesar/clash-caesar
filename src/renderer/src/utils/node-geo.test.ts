import { describe, expect, it } from 'vitest'
import { isNodeDown, regionKeyOfNode, UNKNOWN_REGION } from './node-geo'

const geo: Record<string, INodeGeo> = {
  'HK 01': { server: 'a:1', country: 'HK', updated: 1 },
  'SH 01': { server: 'b:1', country: 'CN', region: '上海', updated: 1 }
}
const tested = (delay: number): IMihomoHistory[] => [{ time: '', delay }]

describe('node region', () => {
  it('uses the cached exit location of nodes that work', () => {
    expect(regionKeyOfNode(geo, { name: 'HK 01', history: tested(80) })).toBe('HK')
    expect(regionKeyOfNode(geo, { name: 'SH 01', history: [] })).toBe('CN-上海')
  })

  it('puts nodes whose latest test timed out under unknown', () => {
    expect(isNodeDown({ history: [...tested(80), ...tested(0)] })).toBe(true)
    expect(regionKeyOfNode(geo, { name: 'HK 01', history: tested(0) })).toBe(UNKNOWN_REGION)
  })

  it('returns to the cached location once the node works again', () => {
    expect(isNodeDown({ history: [...tested(0), ...tested(120)] })).toBe(false)
    expect(regionKeyOfNode(geo, { name: 'HK 01', history: [...tested(0), ...tested(120)] })).toBe(
      'HK'
    )
  })

  it('treats untested nodes as working', () => {
    expect(isNodeDown(undefined)).toBe(false)
    expect(isNodeDown({ history: [] })).toBe(false)
  })
})
