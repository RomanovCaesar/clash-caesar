import { installButtons } from './button'
import { setGlassWallpaper, startGlassGL } from './glass-gl'
import { installTabBars } from './tabbar'
import { installToggles } from './toggle'

// Liquid Glass 主题的运行时：WebGL 壁纸层、开关、标签栏和按钮的弹簧交互。
// 这些模块直接接管 DOM，装上之后无法干净地卸载，所以切换到其它主题时由调用方重新加载窗口。

let installed = false

export function isLiquidGlassInstalled(): boolean {
  return installed
}

export function installLiquidGlass(): void {
  if (installed) return
  installed = true
  if (!startGlassGL()) {
    // 没有 WebGL 时保留 CSS 材质的降级外观
    document.documentElement.dataset.glassGl = 'off'
  }
  installToggles()
  installTabBars()
  installButtons()
}

export interface LiquidWallpaper {
  // 用户壁纸的 data URL，空表示不用壁纸（背景是主题底色）
  image?: string
  blur: number
  // 遮罩比例 0-1
  dim: number
}

export function updateLiquidWallpaper({ image, blur, dim }: LiquidWallpaper): void {
  setGlassWallpaper(image ? { url: image, blur, veil: dim } : { url: '', blur: 0, veil: 0 })
}
