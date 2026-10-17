/**
 * The desktop's settings, kept in the user's `~/.config/ecmaos/desktop.json`: the wallpaper and the number of workspaces.
 */

export type Wallpaper =
  | { kind: 'preset', id: string }
  | { kind: 'color', value: string }
  /** A file under the user's configuration directory, copied there when it was chosen */
  | { kind: 'image', file: string }

export interface DesktopSettings {
  wallpaper: Wallpaper
  workspaces: number
}

export const Presets: Array<{ id: string, name: string, css: string }> = [
  { id: 'dusk', name: 'Dusk', css: 'radial-gradient(circle at 30% 20%, #2a3b55 0%, #141a26 60%, #0b0e14 100%)' },
  { id: 'ember', name: 'Ember', css: 'radial-gradient(circle at 70% 30%, #5a2a2a 0%, #251417 60%, #0e0809 100%)' },
  { id: 'forest', name: 'Forest', css: 'radial-gradient(circle at 25% 75%, #284a3a 0%, #13241d 60%, #090e0c 100%)' },
  { id: 'slate', name: 'Slate', css: 'linear-gradient(160deg, #3a3f4b 0%, #1d2027 100%)' },
  { id: 'paper', name: 'Paper', css: 'linear-gradient(160deg, #e9e6df 0%, #cfcabe 100%)' }
]

export const DefaultSettings: DesktopSettings = { wallpaper: { kind: 'preset', id: 'dusk' }, workspaces: 4 }

const MaxWorkspaces = 16
const ColorPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const ImageFilePattern = /^wallpaper\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i

/** Where the settings live for a home directory */
export const settingsPaths = (home: string) => ({
  directory: `${home}/.config/ecmaos`,
  file: `${home}/.config/ecmaos/desktop.json`
})

/** Reads settings text; anything missing or invalid is the default, so a bad file never keeps the desktop from starting */
export function parseSettings(text: string | undefined): DesktopSettings {
  let value: unknown
  try { value = text === undefined ? undefined : JSON.parse(text) } catch { return { ...DefaultSettings } }
  if (typeof value !== 'object' || value === null) return { ...DefaultSettings }
  const { wallpaper, workspaces } = value as { wallpaper?: unknown, workspaces?: unknown }
  return {
    wallpaper: parseWallpaper(wallpaper) ?? DefaultSettings.wallpaper,
    workspaces: typeof workspaces === 'number' && Number.isInteger(workspaces) ? Math.min(MaxWorkspaces, Math.max(1, workspaces)) : DefaultSettings.workspaces
  }
}

function parseWallpaper(value: unknown): Wallpaper | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, id, value: color, file } = value as Record<string, unknown>
  if (kind === 'preset' && typeof id === 'string' && Presets.some(preset => preset.id === id)) return { kind, id }
  if (kind === 'color' && typeof color === 'string' && ColorPattern.test(color)) return { kind, value: color }
  if (kind === 'image' && typeof file === 'string' && ImageFilePattern.test(file)) return { kind, file }
}

export const serializeSettings = (settings: DesktopSettings) => JSON.stringify(settings, null, 2) + '\n'

/** The CSS `background` for a wallpaper; an image needs the URL it was loaded as */
export function wallpaperCss(wallpaper: Wallpaper, imageUrl?: string): string {
  switch (wallpaper.kind) {
    case 'preset': return (Presets.find(preset => preset.id === wallpaper.id) ?? Presets[0]!).css
    case 'color': return wallpaper.value
    case 'image': return imageUrl ? `center / cover no-repeat url("${imageUrl.replace(/["\\\n]/g, '')}")` : Presets[0]!.css
  }
}

/** The file name an image is stored as: `wallpaper` and the extension of the chosen file, when it is a picture type */
export function imageFileName(chosen: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(chosen)
  const name = match ? `wallpaper.${match[1]!.toLowerCase()}` : undefined
  return name && ImageFilePattern.test(name) ? name : undefined
}
