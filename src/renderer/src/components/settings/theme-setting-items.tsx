import { Button, Slider, Tab, Tabs } from '@heroui/react'
import {
  DEFAULT_WALLPAPER_BLUR,
  DEFAULT_WALLPAPER_DIM,
  previewWallpaperBlur,
  previewWallpaperDim
} from '@renderer/components/base/app-backdrop'
import { toast } from '@renderer/components/base/toast'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { clearWallpaper, getFilePath, setWallpaper } from '@renderer/utils/ipc'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SettingItem from '../base/base-setting-item'

const WALLPAPER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']

// 外观设置里的「主题」和紧跟其后的「壁纸」
const ThemeSettingItems: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig, mutateAppConfig } = useAppConfig()
  const {
    uiTheme = 'default',
    wallpaper = '',
    wallpaperBlur = DEFAULT_WALLPAPER_BLUR,
    wallpaperDim = DEFAULT_WALLPAPER_DIM
  } = appConfig || {}
  const [busy, setBusy] = useState(false)
  const [blur, setBlur] = useState(wallpaperBlur)
  const [dim, setDim] = useState(wallpaperDim)
  useEffect(() => setBlur(wallpaperBlur), [wallpaperBlur])
  useEffect(() => setDim(wallpaperDim), [wallpaperDim])

  const pickWallpaper = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const files = await getFilePath(
        WALLPAPER_EXTENSIONS,
        t('settings.wallpaperDialogTitle'),
        t('settings.wallpaperFilter')
      )
      if (!files?.length) return
      await setWallpaper(files[0])
    } catch (e) {
      toast.error(`${t('settings.wallpaperFailed')}: ${e}`)
    } finally {
      mutateAppConfig()
      setBusy(false)
    }
  }

  const removeWallpaper = async (): Promise<void> => {
    try {
      await clearWallpaper()
    } catch (e) {
      toast.error(String(e))
    } finally {
      mutateAppConfig()
    }
  }

  return (
    <>
      <SettingItem title={t('settings.uiTheme')} divider>
        <Tabs
          size="sm"
          color="primary"
          selectedKey={uiTheme}
          onSelectionChange={(key) => patchAppConfig({ uiTheme: key as UiTheme })}
        >
          <Tab key="default" title={t('settings.uiThemeDefault')} />
          <Tab key="liquidGlass" title="Liquid Glass" />
          <Tab key="material" title="Material Design 3" />
        </Tabs>
      </SettingItem>
      <SettingItem title={t('settings.wallpaper')} divider>
        <div className="flex gap-2">
          {wallpaper && (
            <Button size="sm" variant="flat" color="danger" onPress={removeWallpaper}>
              {t('settings.wallpaperClear')}
            </Button>
          )}
          <Button size="sm" color="primary" isLoading={busy} onPress={pickWallpaper}>
            {wallpaper ? t('settings.wallpaperChange') : t('settings.wallpaperSelect')}
          </Button>
        </div>
      </SettingItem>
      {wallpaper && (
        <>
          <SettingItem title={t('settings.wallpaperBlur')} divider>
            <div className="flex items-center gap-3">
              <Slider
                size="sm"
                aria-label={t('settings.wallpaperBlur')}
                className="w-[200px]"
                minValue={0}
                maxValue={40}
                step={1}
                value={blur}
                onChange={(v) => {
                  setBlur(Number(v))
                  previewWallpaperBlur(Number(v))
                }}
                onChangeEnd={(v) => patchAppConfig({ wallpaperBlur: Number(v) })}
              />
              <span className="w-12 text-right text-sm text-foreground-500">{blur} px</span>
            </div>
          </SettingItem>
          <SettingItem title={t('settings.wallpaperDim')} divider>
            <div className="flex items-center gap-3">
              <Slider
                size="sm"
                aria-label={t('settings.wallpaperDim')}
                className="w-[200px]"
                minValue={0}
                maxValue={90}
                step={1}
                value={dim}
                onChange={(v) => {
                  setDim(Number(v))
                  previewWallpaperDim(Number(v))
                }}
                onChangeEnd={(v) => patchAppConfig({ wallpaperDim: Number(v) })}
              />
              <span className="w-12 text-right text-sm text-foreground-500">{dim}%</span>
            </div>
          </SettingItem>
        </>
      )}
    </>
  )
}

export default ThemeSettingItems
