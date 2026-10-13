import React, { ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { showError } from '@renderer/utils/error-display'
import {
  getSubTemplateConfig,
  mihomoHotReloadConfig,
  patchSubTemplateConfig as patch
} from '@renderer/utils/ipc'
import { createConfigContext } from './create-config-context'

const { Provider, useConfig } = createConfigContext<ISubTemplateConfig>({
  swrKey: 'getSubTemplateConfig',
  fetcher: getSubTemplateConfig,
  ipcEvent: 'subTemplateConfigUpdated'
})

type SubTemplatePatch = Partial<
  Pick<ISubTemplateConfig, 'enabled' | 'global' | 'variant' | 'overrideSettings'>
>

interface SubTemplateConfigContextType {
  subTemplateConfig: ISubTemplateConfig | undefined
  mutateSubTemplateConfig: () => void
  // 修改模版设置并让内核重新加载配置
  patchSubTemplateConfig: (value: SubTemplatePatch) => Promise<void>
}

const SubTemplateConfigContext = React.createContext<SubTemplateConfigContextType | undefined>(
  undefined
)

export const SubTemplateConfigProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <Provider>
      <SubTemplateConfigContextWrapper>{children}</SubTemplateConfigContextWrapper>
    </Provider>
  )
}

const SubTemplateConfigContextWrapper: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { config, mutate } = useConfig()
  const { t } = useTranslation()

  const patchSubTemplateConfig = useCallback(
    async (value: SubTemplatePatch): Promise<void> => {
      try {
        await patch(value)
        await mihomoHotReloadConfig()
      } catch (e) {
        await showError(e, t('common.error.updateSubTemplateFailed'))
      } finally {
        mutate()
      }
    },
    [mutate, t]
  )

  return (
    <SubTemplateConfigContext.Provider
      value={{ subTemplateConfig: config, mutateSubTemplateConfig: mutate, patchSubTemplateConfig }}
    >
      {children}
    </SubTemplateConfigContext.Provider>
  )
}

export const useSubTemplateConfig = (): SubTemplateConfigContextType => {
  const context = React.useContext(SubTemplateConfigContext)
  if (!context) {
    throw new Error('useSubTemplateConfig must be used within a SubTemplateConfigProvider')
  }
  return context
}
