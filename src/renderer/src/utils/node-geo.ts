import { CHINA_PROVINCE_POINTS } from '../../../shared/nodeGeo'
import { COUNTRY_POINTS } from './country-points'

// 未查到出口位置的节点归入这一组
export const UNKNOWN_REGION = ''

// 节点在列表和地图上的归属：一般是国家码；中国大陆查到省份时为 "CN-省份"
export function regionKeyOf(geo: INodeGeo | undefined): string {
  if (!geo?.country) return UNKNOWN_REGION
  if (geo.country === 'CN' && geo.region) return `CN-${geo.region}`
  return geo.country
}

export function countryOfRegion(key: string): string {
  return key.split('-')[0]
}

const displayNamesCache = new Map<string, Intl.DisplayNames>()

function countryName(code: string, language: string): string {
  let names = displayNamesCache.get(language)
  if (!names) {
    try {
      names = new Intl.DisplayNames([language], { type: 'region' })
    } catch {
      names = new Intl.DisplayNames(['en'], { type: 'region' })
    }
    displayNamesCache.set(language, names)
  }
  return names.of(code) ?? code
}

// 区域的显示名：国家名随界面语言；中国大陆的省份附在国家名后
export function regionLabel(key: string, language: string, unknownLabel: string): string {
  if (key === UNKNOWN_REGION) return unknownLabel
  const [country, province] = key.split('-')
  const name = countryName(country, language)
  return province ? `${name} · ${province}` : name
}

// 区域在地图上的标记坐标 [经度, 纬度]
export function regionPoint(key: string): [number, number] | undefined {
  if (key === UNKNOWN_REGION) return undefined
  const [country, province] = key.split('-')
  if (province && CHINA_PROVINCE_POINTS[province]) return CHINA_PROVINCE_POINTS[province]
  const point = COUNTRY_POINTS[country]
  return point ? [point[0], point[1]] : undefined
}

// 有节点的国家在地图上高亮，地图数据用 ISO 数字码标识国家
export function countryNumericId(code: string): string | undefined {
  return COUNTRY_POINTS[code]?.[2]
}

// 非节点成员（子分组、DIRECT、REJECT 等）
export function isNodeMember(proxy: IMihomoProxy | IMihomoGroup): boolean {
  if ('all' in proxy) return false
  return ![
    'Direct',
    'Reject',
    'RejectDrop',
    'Compatible',
    'Pass',
    'Dns',
    'Selector',
    'URLTest',
    'Fallback',
    'LoadBalance',
    'Relay'
  ].includes(proxy.type)
}
