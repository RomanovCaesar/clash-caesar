import { dialog, Notification } from 'electron'
import i18next from 'i18next'
import { DEEP_LINK_SCHEMES } from '../shared/appConfig'
import { addProfileItem } from './config'
import { installRemotePlugin, loginPlugin } from './resolve/plugin'
import { mainWindow } from './window'
import { safeShowErrorBox } from './utils/init'

export function findDeepLink(args: string[]): string | undefined {
  return args.find((arg) => {
    const lower = arg.toLowerCase()
    return DEEP_LINK_SCHEMES.some((scheme) => lower.startsWith(`${scheme}://`))
  })
}

// 深链可以由任何网页触发：导入订阅、安装插件前先让用户看清地址并确认
async function confirmDeepLink(
  kind: 'config' | 'plugin',
  target: string,
  name?: string | null
): Promise<boolean> {
  const detail = [
    name ? `${i18next.t('deepLink.name')}: ${name}` : '',
    `${i18next.t('deepLink.address')}: ${target}`
  ]
    .filter(Boolean)
    .join('\n')
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Clash Caesar',
    message: i18next.t(kind === 'config' ? 'deepLink.confirmImport' : 'deepLink.confirmPlugin'),
    detail: `${detail}\n\n${i18next.t('deepLink.trustHint')}`,
    buttons: [
      i18next.t(kind === 'config' ? 'deepLink.import' : 'deepLink.install'),
      i18next.t('common.cancel')
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

export async function handleDeepLink(url: string): Promise<void> {
  if (!findDeepLink([url])) return

  const urlObj = new URL(url)
  switch (urlObj.host) {
    case 'install-config': {
      try {
        const profileUrl = urlObj.searchParams.get('url')
        const profileName = urlObj.searchParams.get('name')
        if (!profileUrl) {
          throw new Error(i18next.t('profiles.error.urlParamMissing'))
        }
        if (!(await confirmDeepLink('config', profileUrl, profileName))) break
        await addProfileItem({
          type: 'remote',
          name: profileName ?? undefined,
          url: profileUrl
        })
        mainWindow?.webContents.send('profileConfigUpdated')
        new Notification({ title: i18next.t('profiles.notification.importSuccess') }).show()
      } catch (e) {
        safeShowErrorBox('profiles.error.importFailed', `${url}\n${e}`)
      }
      break
    }
    case 'install-plugin': {
      let plugin: IPluginItem
      try {
        const pluginUrl = urlObj.searchParams.get('url')
        if (!pluginUrl) {
          throw new Error(i18next.t('profiles.error.urlParamMissing'))
        }
        if (!(await confirmDeepLink('plugin', pluginUrl))) break
        plugin = await installRemotePlugin(pluginUrl)
        new Notification({ title: i18next.t('plugins.installed') }).show()
      } catch (e) {
        safeShowErrorBox('plugins.installFailed', `${e}`)
        break
      }

      try {
        await loginPlugin(plugin.id)
        new Notification({ title: i18next.t('plugins.loginSuccess') }).show()
      } catch (e) {
        safeShowErrorBox('plugins.loginFailed', `${e}`)
      }
      break
    }
  }
}
