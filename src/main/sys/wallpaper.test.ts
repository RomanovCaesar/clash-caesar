import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { clearWallpaper, getWallpaperDataURL, setWallpaper } from './wallpaper'

const state = vi.hoisted(() => ({ dir: '', config: {} as Partial<IAppConfig> }))
vi.mock('../config', () => ({
  getAppConfig: () => Promise.resolve(state.config),
  patchAppConfig: (patch: Partial<IAppConfig>) => {
    Object.assign(state.config, patch)
    return Promise.resolve()
  }
}))
vi.mock('../utils/dirs', () => ({ wallpaperDir: () => path.join(state.dir, 'wallpaper') }))

state.dir = mkdtempSync(path.join(tmpdir(), 'wallpaper-test-'))
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))

function image(name: string, content: string): string {
  const file = path.join(state.dir, name)
  writeFileSync(file, content)
  return file
}

describe('wallpaper', () => {
  it('copies the image into the data directory and serves it as a data URL', async () => {
    const name = await setWallpaper(image('photo.JPG', 'first'))
    expect(name).toMatch(/^[0-9a-f]{16}\.jpg$/)
    expect(state.config.wallpaper).toBe(name)
    expect(await getWallpaperDataURL()).toBe(
      `data:image/jpeg;base64,${Buffer.from('first').toString('base64')}`
    )
  })

  it('keeps only the current wallpaper file', async () => {
    const name = await setWallpaper(image('next.png', 'second'))
    expect(readdirSync(path.join(state.dir, 'wallpaper'))).toEqual([name])
  })

  it('rejects files that are not images', async () => {
    await expect(setWallpaper(image('notes.txt', 'x'))).rejects.toThrow()
  })

  it('ignores a configured name that points outside the wallpaper directory', async () => {
    state.config.wallpaper = '../photo.JPG'
    expect(await getWallpaperDataURL()).toBeUndefined()
  })

  it('clears the wallpaper', async () => {
    await setWallpaper(image('again.webp', 'third'))
    await clearWallpaper()
    expect(state.config.wallpaper).toBe('')
    expect(await getWallpaperDataURL()).toBeUndefined()
    expect(existsSync(path.join(state.dir, 'wallpaper'))).toBe(true)
    expect(readdirSync(path.join(state.dir, 'wallpaper'))).toEqual([])
  })
})
