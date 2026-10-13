import React, { useState } from 'react'
import { Input, Switch, Tooltip } from '@heroui/react'
import { IoMdInformationCircleOutline } from 'react-icons/io'
import { useTranslation } from 'react-i18next'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import { toast } from '@renderer/components/base/toast'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import debounce from '@renderer/utils/debounce'
import { mihomoHotReloadConfig, refreshNodeGeo } from '@renderer/utils/ipc'

const InfoTip: React.FC<{ content: string }> = ({ content }) => (
  <Tooltip content={content} placement="top" className="max-w-xs">
    <IoMdInformationCircleOutline className="ml-1 text-foreground-400 cursor-help" />
  </Tooltip>
)

const NodeGeoConfig: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { nodeGeoEnabled = true, hideExitIp = true, ipinfoToken = '' } = appConfig || {}
  const [token, setToken] = useState(ipinfoToken)
  const saveToken = debounce(async (v: string) => {
    await patchAppConfig({ ipinfoToken: v.trim() })
  }, 500)

  return (
    <SettingCard title={t('settings.nodeGeo.title')}>
      <SettingItem
        title={t('settings.nodeGeo.enable')}
        actions={<InfoTip content={t('settings.nodeGeo.enableTooltip')} />}
        divider
      >
        <Switch
          size="sm"
          isSelected={nodeGeoEnabled}
          onValueChange={async (v) => {
            try {
              await patchAppConfig({ nodeGeoEnabled: v })
              // 探测通道在内核配置里，开关后要重新加载配置
              await mihomoHotReloadConfig()
              if (v) await refreshNodeGeo()
            } catch (e) {
              toast.error(String(e))
            }
          }}
        />
      </SettingItem>
      <SettingItem
        title={t('settings.nodeGeo.hideExitIp')}
        actions={<InfoTip content={t('settings.nodeGeo.hideExitIpTooltip')} />}
        divider
      >
        <Switch
          size="sm"
          isSelected={hideExitIp}
          onValueChange={(v) => patchAppConfig({ hideExitIp: v })}
        />
      </SettingItem>
      <SettingItem
        title={t('settings.nodeGeo.ipinfoToken')}
        actions={<InfoTip content={t('settings.nodeGeo.ipinfoTokenTooltip')} />}
      >
        <Input
          size="sm"
          type="password"
          className="w-[300px]"
          placeholder={t('settings.nodeGeo.ipinfoTokenPlaceholder')}
          value={token}
          onValueChange={(v) => {
            setToken(v)
            saveToken(v)
          }}
        />
      </SettingItem>
    </SettingCard>
  )
}

export default NodeGeoConfig
