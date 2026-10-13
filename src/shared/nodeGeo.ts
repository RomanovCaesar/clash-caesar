// 节点出口位置：主进程查询与渲染进程展示共用的数据与解析函数

// 中国大陆各省级行政区在地图上的标记坐标 [经度, 纬度]（取省会附近）
export const CHINA_PROVINCE_POINTS: Record<string, [number, number]> = {
  北京: [116.4, 39.9],
  天津: [117.2, 39.1],
  河北: [114.5, 38.0],
  山西: [112.5, 37.9],
  内蒙古: [111.7, 40.8],
  辽宁: [123.4, 41.8],
  吉林: [125.3, 43.9],
  黑龙江: [126.6, 45.8],
  上海: [121.5, 31.2],
  江苏: [118.8, 32.1],
  浙江: [120.2, 30.3],
  安徽: [117.3, 31.9],
  福建: [119.3, 26.1],
  江西: [115.9, 28.7],
  山东: [117.0, 36.7],
  河南: [113.6, 34.8],
  湖北: [114.3, 30.6],
  湖南: [112.9, 28.2],
  广东: [113.3, 23.1],
  广西: [108.3, 22.8],
  海南: [110.3, 20.0],
  重庆: [106.5, 29.6],
  四川: [104.1, 30.7],
  贵州: [106.7, 26.6],
  云南: [102.7, 25.0],
  西藏: [91.1, 29.7],
  陕西: [108.9, 34.3],
  甘肃: [103.8, 36.1],
  青海: [101.8, 36.6],
  宁夏: [106.3, 38.5],
  新疆: [87.6, 43.8]
}

export interface ParsedIpinfo {
  ip: string
  country: string
  org?: string
}

// 解析 ipinfo.io/json 的响应；国家码统一成大写二字母，取不到时为空串
export function parseIpinfo(data: unknown): ParsedIpinfo {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid ipinfo response')
  const record = data as Record<string, unknown>
  if (typeof record.ip !== 'string' || record.ip === '') {
    const message = (record.error as { message?: string } | undefined)?.message
    throw new Error(message ? `ipinfo: ${message}` : 'Invalid ipinfo response')
  }
  const country =
    typeof record.country === 'string' && /^[A-Za-z]{2}$/.test(record.country)
      ? record.country.toUpperCase()
      : ''
  return {
    ip: record.ip,
    country,
    org: typeof record.org === 'string' && record.org ? record.org : undefined
  }
}

// 解析 myip.ipip.net 的文本响应，例如 "当前 IP：1.2.3.4  来自于：中国 广东 深圳  电信"，
// 返回省级行政区名；不在中国大陆或认不出省份时返回 undefined
export function parseIpipProvince(text: string): string | undefined {
  const match = text.match(/来自于[：:]\s*(.+)/)
  if (!match) return undefined
  const parts = match[1].trim().split(/\s+/)
  if (parts[0] !== '中国') return undefined
  const province = (parts[1] ?? '').replace(
    /(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区)$/,
    ''
  )
  return province in CHINA_PROVINCE_POINTS ? province : undefined
}

// 隐私模式下只显示出口 IP 的前两段：IPv4 显示 a.b.*.*，IPv6 显示前两组
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((part) => part !== '')
    return `${groups.slice(0, 2).join(':')}:*:*`
  }
  const parts = ip.split('.')
  if (parts.length !== 4) return ip
  return `${parts[0]}.${parts[1]}.*.*`
}
