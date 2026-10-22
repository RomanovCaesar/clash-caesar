// 常见的境外公共 DNS。在中国大陆直连它们通常会被干扰：被墙域名解析超时，
// mihomo 需要先在本地解析域名的 UDP 流量（STUN / WebRTC / QUIC / 游戏）就会悄悄失效。
const OVERSEAS_DNS_HOSTS = new Set([
  '1.1.1.1',
  '1.0.0.1',
  '8.8.8.8',
  '8.8.4.4',
  '9.9.9.9',
  '149.112.112.112',
  '208.67.222.222',
  '208.67.220.220',
  '94.140.14.14',
  '94.140.15.15',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001',
  '2001:4860:4860::8888',
  '2001:4860:4860::8844',
  'dns.google',
  'dns.google.com',
  'cloudflare-dns.com',
  'one.one.one.one',
  'security.cloudflare-dns.com',
  'dns.quad9.net',
  'doh.opendns.com',
  'dns.adguard.com',
  'dns.adguard-dns.com',
  'doh.dns.sb',
  'dns.nextdns.io'
])

// 取出 nameserver 写法里的主机名：https://dns.google/dns-query、tls://1.1.1.1:853、
// quic://[2606:4700:4700::1111]、8.8.8.8#DIRECT 等
export function nameserverHost(nameserver: string): string {
  let rest = nameserver.trim().split('#')[0]
  rest = rest.replace(/^[a-z0-9+.-]+:\/\//i, '')
  rest = rest.split('/')[0]
  if (rest.startsWith('[')) return rest.slice(1, rest.indexOf(']')).toLowerCase()
  // 只有一个冒号才是端口；多个冒号是不带方括号的 IPv6
  if (rest.split(':').length === 2) rest = rest.split(':')[0]
  return rest.toLowerCase()
}

export function isOverseasNameserver(nameserver: string): boolean {
  return OVERSEAS_DNS_HOSTS.has(nameserverHost(nameserver))
}

// 上游 DNS 全是境外公共 DNS、又没开「遵守规则」时，这些查询直连出去，在国内大概率失败
export function needsRespectRulesHint(nameserver: string[], respectRules: boolean): boolean {
  const servers = nameserver.filter((s) => s.trim() !== '')
  return !respectRules && servers.length > 0 && servers.every(isOverseasNameserver)
}
