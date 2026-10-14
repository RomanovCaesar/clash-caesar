import { useAppConfig } from '@renderer/hooks/use-app-config'
import { getWallpaperDataURL } from '@renderer/utils/ipc'
import {
  installLiquidGlass,
  isLiquidGlassInstalled,
  updateLiquidWallpaper,
  type LiquidWallpaper
} from '@renderer/liquid'
import React, { useEffect } from 'react'
import useSWR from 'swr'

export const DEFAULT_WALLPAPER_BLUR = 0
export const DEFAULT_WALLPAPER_DIM = 45

const THEME_ATTR: Record<UiTheme, string> = {
  default: 'default',
  liquidGlass: 'liquid-glass',
  material: 'material'
}

// Liquid Glass 的壁纸由 WebGL 层自己画，设置页拖动滑块时也要同步给它
const liquidWallpaper: LiquidWallpaper = { blur: 0, dim: 0 }
let blurFrame = 0

// 设置页拖动滑块时直接改 CSS 变量预览，松手后再写配置
export function previewWallpaperBlur(px: number): void {
  document.documentElement.style.setProperty('--wallpaper-blur', `${px}px`)
  liquidWallpaper.blur = px
  // 模糊要重做纹理，每帧最多一次
  if (isLiquidGlassInstalled() && !blurFrame) {
    blurFrame = requestAnimationFrame(() => {
      blurFrame = 0
      updateLiquidWallpaper(liquidWallpaper)
    })
  }
}

export function previewWallpaperDim(percent: number): void {
  document.documentElement.style.setProperty('--wallpaper-dim', `${percent / 100}`)
  liquidWallpaper.dim = percent / 100
  if (isLiquidGlassInstalled()) updateLiquidWallpaper(liquidWallpaper)
}

// 整个界面背后的一层：主题标记、壁纸图片和遮罩。主题本身的样式在 assets/themes.css，
// Liquid Glass 的壁纸和玻璃由 liquid/ 下的 WebGL 层画。
const AppBackdrop: React.FC = () => {
  const { appConfig } = useAppConfig()
  const {
    uiTheme = 'default',
    wallpaper = '',
    wallpaperBlur = DEFAULT_WALLPAPER_BLUR,
    wallpaperDim = DEFAULT_WALLPAPER_DIM
  } = appConfig || {}
  const liquid = uiTheme === 'liquidGlass'
  const { data: image } = useSWR(wallpaper ? ['getWallpaperDataURL', wallpaper] : null, () =>
    getWallpaperDataURL()
  )
  const hasWallpaper = Boolean(wallpaper && image)

  useEffect(() => {
    if (!appConfig) return
    document.documentElement.dataset.uiTheme = THEME_ATTR[uiTheme] ?? 'default'
    if (liquid) {
      installLiquidGlass()
    } else if (isLiquidGlassInstalled()) {
      // 液态玻璃的控件直接接管了 DOM，换到其它主题时重新加载窗口最干净
      window.location.reload()
    }
  }, [appConfig, uiTheme, liquid])

  useEffect(() => {
    if (hasWallpaper) document.documentElement.dataset.wallpaper = ''
    else delete document.documentElement.dataset.wallpaper
  }, [hasWallpaper])

  useEffect(() => {
    previewWallpaperBlur(wallpaperBlur)
    previewWallpaperDim(wallpaperDim)
  }, [wallpaperBlur, wallpaperDim])

  useEffect(() => {
    if (!liquid) return
    liquidWallpaper.image = hasWallpaper ? image : undefined
    liquidWallpaper.blur = wallpaperBlur
    liquidWallpaper.dim = hasWallpaper ? wallpaperDim / 100 : 0
    updateLiquidWallpaper(liquidWallpaper)
  }, [liquid, hasWallpaper, image, wallpaperBlur, wallpaperDim])

  return (
    <div className="app-backdrop" aria-hidden>
      {hasWallpaper && !liquid && (
        <>
          <div className="app-backdrop-image" style={{ backgroundImage: `url("${image}")` }} />
          <div className="app-backdrop-dim" />
        </>
      )}
    </div>
  )
}

export default AppBackdrop
