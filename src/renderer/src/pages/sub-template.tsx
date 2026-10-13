import {
  Button,
  Divider,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
  Input,
  Select,
  SelectItem,
  Switch,
  Tab,
  Tabs,
  Tooltip
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import { toast } from '@renderer/components/base/toast'
import ImportModal from '@renderer/components/sub-template/import-modal'
import TemplateItem from '@renderer/components/sub-template/template-item'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useSubTemplateConfig } from '@renderer/hooks/use-sub-template-config'
import { fetchSubTemplateUrl, getFilePath, getProfileStr, readTextFile } from '@renderer/utils/ipc'
import React, { useState } from 'react'
import { FaPlus } from 'react-icons/fa6'
import { IoMdInformationCircleOutline } from 'react-icons/io'
import { MdContentPaste } from 'react-icons/md'
import { useTranslation } from 'react-i18next'

const BUILTIN_ID = 'builtin'
const VARIANTS: SubTemplateVariant[] = ['cn', 'ru', 'ir']

const InfoTip: React.FC<{ content: string }> = ({ content }) => (
  <Tooltip content={content} placement="top" className="max-w-xs">
    <IoMdInformationCircleOutline className="ml-1 text-foreground-400 cursor-help" />
  </Tooltip>
)

const SubTemplate: React.FC = () => {
  const { t } = useTranslation()
  const { subTemplateConfig, patchSubTemplateConfig, mutateSubTemplateConfig } =
    useSubTemplateConfig()
  const { profileConfig } = useProfileConfig()
  const {
    enabled = false,
    global = BUILTIN_ID,
    variant = 'cn',
    overrideSettings = false,
    items = []
  } = subTemplateConfig || {}
  const profiles = profileConfig?.items ?? []
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [source, setSource] = useState<{ name: string; content: string }>()

  const builtinName = t('subTemplate.builtin')

  const importFromUrl = async (): Promise<void> => {
    setFetching(true)
    try {
      const content = await fetchSubTemplateUrl(url)
      const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
      setSource({ name: fileName.replace(/\.(ya?ml)$/i, '') || 'Template', content })
    } catch (e) {
      toast.error(String(e), t('subTemplate.error.importFailed'))
    } finally {
      setFetching(false)
    }
  }

  const onAddAction = async (key: React.Key): Promise<void> => {
    try {
      if (key === 'file') {
        const files = await getFilePath(['yaml', 'yml'])
        if (!files?.length) return
        const content = await readTextFile(files[0])
        const fileName = files[0].split(/[\\/]/).pop() || ''
        setSource({ name: fileName.replace(/\.(ya?ml)$/i, ''), content })
        return
      }
      const profile = profiles.find((p) => `profile:${p.id}` === key)
      if (profile) {
        setSource({ name: profile.name, content: await getProfileStr(profile.id) })
      }
    } catch (e) {
      toast.error(String(e), t('subTemplate.error.importFailed'))
    }
  }

  return (
    <BasePage title={t('subTemplate.title')}>
      {source && (
        <ImportModal
          source={source}
          onImported={() => mutateSubTemplateConfig()}
          onClose={() => setSource(undefined)}
        />
      )}
      <div className="sticky top-0 z-40 bg-background">
        <div className="flex p-2">
          <Input
            size="sm"
            placeholder={t('subTemplate.input.placeholder')}
            value={url}
            onValueChange={setUrl}
            endContent={
              <Button
                size="sm"
                isIconOnly
                variant="light"
                onPress={() => {
                  navigator.clipboard.readText().then(setUrl)
                }}
              >
                <MdContentPaste className="text-lg" />
              </Button>
            }
          />
          <Button
            size="sm"
            color="primary"
            className="ml-2"
            isDisabled={url === ''}
            isLoading={fetching}
            onPress={importFromUrl}
          >
            {t('subTemplate.import')}
          </Button>
          <Dropdown>
            <DropdownTrigger>
              <Button className="ml-2" size="sm" isIconOnly color="primary">
                <FaPlus />
              </Button>
            </DropdownTrigger>
            <DropdownMenu onAction={onAddAction}>
              <DropdownSection showDivider={profiles.length > 0}>
                <DropdownItem key="file">{t('subTemplate.actions.file')}</DropdownItem>
              </DropdownSection>
              <DropdownSection title={t('subTemplate.actions.fromProfile')}>
                {profiles.map((profile) => (
                  <DropdownItem key={`profile:${profile.id}`}>{profile.name}</DropdownItem>
                ))}
              </DropdownSection>
            </DropdownMenu>
          </Dropdown>
        </div>
        <Divider />
      </div>

      <SettingCard>
        <SettingItem
          title={t('subTemplate.enable')}
          actions={<InfoTip content={t('subTemplate.enableTooltip')} />}
          divider
        >
          <Switch
            size="sm"
            isSelected={enabled}
            onValueChange={(v) => patchSubTemplateConfig({ enabled: v })}
          />
        </SettingItem>
        <SettingItem
          title={t('subTemplate.global')}
          actions={<InfoTip content={t('subTemplate.globalTooltip')} />}
          divider
        >
          <Select
            classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
            className="w-[200px]"
            size="sm"
            aria-label={t('subTemplate.global')}
            selectedKeys={new Set([global === '' ? 'none' : global])}
            disallowEmptySelection
            onSelectionChange={(v) => {
              const key = v.currentKey as string
              patchSubTemplateConfig({ global: key === 'none' ? '' : key })
            }}
          >
            {[
              <SelectItem key="none">{t('subTemplate.none')}</SelectItem>,
              <SelectItem key={BUILTIN_ID}>{builtinName}</SelectItem>,
              ...items.map((item) => <SelectItem key={item.id}>{item.name}</SelectItem>)
            ]}
          </Select>
        </SettingItem>
        <SettingItem title={t('subTemplate.variant')} divider>
          <Tabs
            size="sm"
            color="primary"
            selectedKey={variant}
            onSelectionChange={(key) =>
              patchSubTemplateConfig({ variant: key as SubTemplateVariant })
            }
          >
            {VARIANTS.map((v) => (
              <Tab key={v} title={t(`subTemplate.variants.${v}`)} />
            ))}
          </Tabs>
        </SettingItem>
        <SettingItem
          title={t('subTemplate.overrideSettings')}
          actions={<InfoTip content={t('subTemplate.overrideSettingsTooltip')} />}
        >
          <Switch
            size="sm"
            isSelected={overrideSettings}
            onValueChange={(v) => patchSubTemplateConfig({ overrideSettings: v })}
          />
        </SettingItem>
      </SettingCard>

      <div className="grid sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 m-2">
        <TemplateItem
          id={BUILTIN_ID}
          name={`${builtinName} · ${t(`subTemplate.variants.${variant}`)}`}
          variant={variant}
          isGlobal={global === BUILTIN_ID}
          onSetGlobal={() => patchSubTemplateConfig({ global: BUILTIN_ID })}
          onChanged={mutateSubTemplateConfig}
        />
        {items.map((item) => (
          <TemplateItem
            key={item.id}
            item={item}
            id={item.id}
            name={item.name}
            variant={variant}
            isGlobal={global === item.id}
            onSetGlobal={() => patchSubTemplateConfig({ global: item.id })}
            onChanged={mutateSubTemplateConfig}
          />
        ))}
      </div>
    </BasePage>
  )
}

export default SubTemplate
