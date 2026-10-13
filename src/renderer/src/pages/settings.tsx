import { Button } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { IoLogoGithub } from 'react-icons/io5'
import WebdavConfig from '@renderer/components/settings/webdav-config'
import GeneralConfig from '@renderer/components/settings/general-config'
import MihomoConfig from '@renderer/components/settings/mihomo-config'
import NodeGeoConfig from '@renderer/components/settings/node-geo-config'
import Actions from '@renderer/components/settings/actions'
import ShortcutConfig from '@renderer/components/settings/shortcut-config'
import { FaTelegramPlane } from 'react-icons/fa'
import SiderConfig from '@renderer/components/settings/sider-config'
import SubStoreConfig from '@renderer/components/settings/substore-config'
import LocalBackupConfig from '@renderer/components/settings/local-backup-config'
import { useTranslation } from 'react-i18next'
import { APP_REPO_URL, APP_TELEGRAM_URL } from '../../../shared/appConfig'

const Settings: React.FC = () => {
  const { t } = useTranslation()

  return (
    <BasePage
      title={t('settings.title')}
      header={
        <>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="app-nodrag"
            title={t('settings.links.github')}
            onPress={() => {
              window.open(APP_REPO_URL)
            }}
          >
            <IoLogoGithub className="text-lg" />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="app-nodrag"
            title={t('settings.links.telegram')}
            onPress={() => {
              window.open(APP_TELEGRAM_URL)
            }}
          >
            <FaTelegramPlane className="text-lg" />
          </Button>
        </>
      }
    >
      <GeneralConfig />
      <NodeGeoConfig />
      <SubStoreConfig />
      <SiderConfig />
      <WebdavConfig />
      <MihomoConfig />
      <ShortcutConfig />
      <LocalBackupConfig />
      <Actions />
    </BasePage>
  )
}

export default Settings
