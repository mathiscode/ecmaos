import { describe, expect, it } from 'vitest'

import { DefaultSettings, imageFileName, parseSettings, serializeSettings, wallpaperCss } from '../src/settings.ts'

describe('desktop settings', () => {
  it('falls back to the defaults for a missing, unreadable or wrong file', () => {
    expect(parseSettings(undefined)).toEqual(DefaultSettings)
    expect(parseSettings('{nope')).toEqual(DefaultSettings)
    expect(parseSettings('[]')).toEqual(DefaultSettings)
    expect(parseSettings('{"wallpaper":{"kind":"preset","id":"gone"},"workspaces":"4"}')).toEqual(DefaultSettings)
  })

  it('round-trips a wallpaper and a workspace count', () => {
    for (const wallpaper of [{ kind: 'preset', id: 'ember' }, { kind: 'color', value: '#1a2b3c' }, { kind: 'image', file: 'wallpaper.png' }] as const) {
      const settings = { wallpaper, workspaces: 6 }
      expect(parseSettings(serializeSettings(settings))).toEqual(settings)
    }
  })

  it('keeps the workspace count between 1 and 16', () => {
    expect(parseSettings('{"workspaces":0}').workspaces).toBe(1)
    expect(parseSettings('{"workspaces":99}').workspaces).toBe(16)
    expect(parseSettings('{"workspaces":2.5}').workspaces).toBe(DefaultSettings.workspaces)
  })

  it('refuses a color or a file that is not what the desktop writes', () => {
    expect(parseSettings('{"wallpaper":{"kind":"color","value":"red; background:url(x)"}}').wallpaper).toEqual(DefaultSettings.wallpaper)
    expect(parseSettings('{"wallpaper":{"kind":"image","file":"../../etc/passwd"}}').wallpaper).toEqual(DefaultSettings.wallpaper)
    expect(parseSettings('{"wallpaper":{"kind":"image","file":"wallpaper.html"}}').wallpaper).toEqual(DefaultSettings.wallpaper)
  })

  it('makes the CSS for each kind', () => {
    expect(wallpaperCss({ kind: 'color', value: '#fff' })).toBe('#fff')
    expect(wallpaperCss({ kind: 'preset', id: 'slate' })).toContain('linear-gradient')
    expect(wallpaperCss({ kind: 'image', file: 'wallpaper.png' }, 'blob:x"y')).toBe('center / cover no-repeat url("blob:xy")')
    expect(wallpaperCss({ kind: 'image', file: 'wallpaper.png' })).toContain('radial-gradient')
  })

  it('names a stored image after its extension, for picture types only', () => {
    expect(imageFileName('Holiday Photo.JPG')).toBe('wallpaper.jpg')
    expect(imageFileName('x.svg')).toBe('wallpaper.svg')
    expect(imageFileName('notes.txt')).toBeUndefined()
    expect(imageFileName('noextension')).toBeUndefined()
  })
})
