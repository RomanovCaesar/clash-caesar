import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findDeepLink, handleDeepLink } from './deeplink'
const notificationShow = vi.fn()
const addProfileItem = vi.fn()
const installRemotePlugin = vi.fn()
const loginPlugin = vi.fn()
const safeShowErrorBox = vi.fn()
const showMessageBox = vi.fn()

vi.mock('electron', () => ({
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  Notification: class {
    show(): void {
      notificationShow()
    }
  }
}))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))
vi.mock('./config', () => ({
  addProfileItem: (...args: unknown[]) => addProfileItem(...args)
}))
vi.mock('./resolve/plugin', () => ({
  installRemotePlugin: (...args: unknown[]) => installRemotePlugin(...args),
  loginPlugin: (...args: unknown[]) => loginPlugin(...args)
}))
vi.mock('./window', () => ({ mainWindow: null }))
vi.mock('./utils/init', () => ({
  safeShowErrorBox: (...args: unknown[]) => safeShowErrorBox(...args)
}))

beforeEach(() => {
  notificationShow.mockReset()
  addProfileItem.mockReset().mockResolvedValue(undefined)
  installRemotePlugin.mockReset().mockResolvedValue({ id: 'plugin-id' })
  loginPlugin.mockReset().mockResolvedValue(undefined)
  safeShowErrorBox.mockReset()
  // 默认用户在确认框里点了「导入 / 安装」
  showMessageBox.mockReset().mockResolvedValue({ response: 0 })
})

describe('findDeepLink', () => {
  it('finds a supported scheme anywhere in the command line', () => {
    expect(findDeepLink(['app', '--flag', 'clash://install-config?url=x'])).toBe(
      'clash://install-config?url=x'
    )
    expect(findDeepLink(['app', 'MIHOMO://install-plugin?url=x'])).toBe(
      'MIHOMO://install-plugin?url=x'
    )
    expect(findDeepLink(['app', 'clash-caesar://install-config?url=x'])).toBe(
      'clash-caesar://install-config?url=x'
    )
  })

  it('imports a subscription from the m-ui "Import to Clash Caesar" link', async () => {
    const sub = 'https://panel.example:2096/sub/abc123/clash?x=1&y=2'
    await handleDeepLink(
      `clash-caesar://install-config?url=${encodeURIComponent(sub)}&name=${encodeURIComponent('张三 user')}`
    )
    expect(addProfileItem).toHaveBeenCalledWith({ type: 'remote', name: '张三 user', url: sub })
    expect(safeShowErrorBox).not.toHaveBeenCalled()
  })

  it('ignores unrelated arguments', () => {
    expect(findDeepLink(['app', '--flag'])).toBeUndefined()
  })
})

describe('install-plugin deep link', () => {
  it('downloads, installs and starts login', async () => {
    const remoteUrl = 'https://provider.example/app.cpx?channel=stable'
    await handleDeepLink(`clash://install-plugin?url=${encodeURIComponent(remoteUrl)}`)

    expect(installRemotePlugin).toHaveBeenCalledWith(remoteUrl)
    expect(loginPlugin).toHaveBeenCalledWith('plugin-id')
    expect(notificationShow).toHaveBeenCalledTimes(2)
    expect(safeShowErrorBox).not.toHaveBeenCalled()
  })

  it('reports an install failure and does not start login', async () => {
    installRemotePlugin.mockRejectedValue(new Error('bad descriptor'))
    await handleDeepLink('mihomo://install-plugin?url=https%3A%2F%2Fprovider.example%2Fapp.cpx')

    expect(loginPlugin).not.toHaveBeenCalled()
    expect(safeShowErrorBox).toHaveBeenCalledWith(
      'plugins.installFailed',
      expect.stringContaining('bad descriptor')
    )
  })

  it('keeps the installed plugin when login fails and reports the login error', async () => {
    loginPlugin.mockRejectedValue(new Error('PLUGIN_LOGIN_FAILED'))
    await handleDeepLink('clash://install-plugin?url=https%3A%2F%2Fprovider.example%2Fapp.cpx')

    expect(installRemotePlugin).toHaveBeenCalledOnce()
    expect(notificationShow).toHaveBeenCalledOnce()
    expect(safeShowErrorBox).toHaveBeenCalledWith(
      'plugins.loginFailed',
      expect.stringContaining('PLUGIN_LOGIN_FAILED')
    )
  })

  it('requires the url parameter', async () => {
    await handleDeepLink('clash://install-plugin')
    expect(installRemotePlugin).not.toHaveBeenCalled()
    expect(safeShowErrorBox).toHaveBeenCalledWith(
      'plugins.installFailed',
      expect.stringContaining('profiles.error.urlParamMissing')
    )
  })
})

describe('deep link confirmation', () => {
  it('shows the subscription address before importing', async () => {
    const sub = 'https://panel.example/sub/abc'
    await handleDeepLink(`clash-caesar://install-config?url=${encodeURIComponent(sub)}&name=Home`)
    const [options] = showMessageBox.mock.calls[0] as [{ detail: string }]
    expect(options.detail).toContain(sub)
    expect(options.detail).toContain('Home')
    expect(addProfileItem).toHaveBeenCalled()
  })

  it('does nothing when the import is cancelled', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    await handleDeepLink('clash-caesar://install-config?url=https%3A%2F%2Fevil.example%2Fsub')
    expect(addProfileItem).not.toHaveBeenCalled()
    expect(notificationShow).not.toHaveBeenCalled()
    expect(safeShowErrorBox).not.toHaveBeenCalled()
  })

  it('neither installs nor logs in when the plugin is cancelled', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    await handleDeepLink('clash://install-plugin?url=https%3A%2F%2Fevil.example%2Fapp.cpx')
    expect(installRemotePlugin).not.toHaveBeenCalled()
    expect(loginPlugin).not.toHaveBeenCalled()
  })
})
