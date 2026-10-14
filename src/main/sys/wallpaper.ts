import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'fs/promises'
import path from 'path'
import { getAppConfig, patchAppConfig } from '../config'
import { wallpaperDir } from '../utils/dirs'

// 壁纸复制到数据目录里（随备份一起带走），配置里只记文件名
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}
export const WALLPAPER_EXTENSIONS = Object.keys(MIME).map((ext) => ext.slice(1))
const MAX_WALLPAPER_BYTES = 30 * 1024 * 1024

async function clearDir(keep?: string): Promise<void> {
  if (!existsSync(wallpaperDir())) return
  for (const name of await readdir(wallpaperDir())) {
    if (name !== keep) await rm(path.join(wallpaperDir(), name), { force: true })
  }
}

export async function setWallpaper(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  if (!MIME[ext]) throw new Error('Unsupported image format')
  const info = await stat(filePath)
  if (!info.isFile() || info.size > MAX_WALLPAPER_BYTES) {
    throw new Error('The image must be smaller than 30 MB')
  }
  const data = await readFile(filePath)
  const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}${ext}`
  await mkdir(wallpaperDir(), { recursive: true })
  await copyFile(filePath, path.join(wallpaperDir(), name))
  await patchAppConfig({ wallpaper: name })
  await clearDir(name)
  return name
}

export async function clearWallpaper(): Promise<void> {
  await patchAppConfig({ wallpaper: '' })
  await clearDir()
}

export async function getWallpaperDataURL(): Promise<string | undefined> {
  const { wallpaper } = await getAppConfig()
  if (!wallpaper || path.basename(wallpaper) !== wallpaper) return undefined
  const file = path.join(wallpaperDir(), wallpaper)
  const mime = MIME[path.extname(wallpaper).toLowerCase()]
  if (!mime || !existsSync(file)) return undefined
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
}
