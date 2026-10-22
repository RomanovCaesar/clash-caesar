import { shell, type WebContents } from 'electron'
import { mainWindowLogger } from './logger'

// 交给系统打开的外部链接只允许 http / https。其它协议（file:、网络共享路径、search-ms:、ms-msdt: 等）
// 会被 Windows 直接执行或交给系统组件处理；这些链接可能来自订阅服务器（例如订阅的「官网」）等不可信来源。
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export async function openExternalSafely(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    await mainWindowLogger.warn(`Refused to open a non-http(s) external link: ${url.slice(0, 200)}`)
    return
  }
  await shell.openExternal(url)
}

const withoutHash = (url: string): string => url.split('#')[0]

// 窗口只能显示应用自己的页面：预加载脚本给页面开放了完整的 IPC（读写文件、修改配置等），
// 任何外部页面都不能在这里打开。链接一律交给系统浏览器（仅 http / https）。
export function lockNavigation(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    // 同一页面换 hash（路由）不算离开应用
    if (withoutHash(url) === withoutHash(contents.getURL())) return
    event.preventDefault()
    void openExternalSafely(url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url)
    return { action: 'deny' }
  })
}
