import { describe, expect, it } from 'vitest'

import { parseDesktopEntry, stripFieldCodes } from '../src/desktop-entry.ts'

const entry = (body: string) => `[Desktop Entry]\nType=Application\n${body}\n`

describe('parseDesktopEntry', () => {
  it('reads the keys a launcher needs', () => {
    expect(parseDesktopEntry('webamp', entry('Name=Webamp\nComment=Winamp for the web\nExec=webamp %U\nIcon=webamp\nCategories=AudioVideo;Player;'))).toEqual({
      id: 'webamp', name: 'Webamp', comment: 'Winamp for the web', exec: 'webamp', terminal: false, icon: 'webamp', categories: ['AudioVideo', 'Player']
    })
  })

  it('knows terminal programs', () => {
    expect(parseDesktopEntry('top', entry('Name=Top\nExec=top\nTerminal=true'))?.terminal).toBe(true)
  })

  it('skips what a menu should not show', () => {
    expect(parseDesktopEntry('a', '[Desktop Entry]\nType=Link\nName=A\nExec=a')).toBeUndefined()
    expect(parseDesktopEntry('b', entry('Name=B\nExec=b\nNoDisplay=true'))).toBeUndefined()
    expect(parseDesktopEntry('c', entry('Name=C\nExec=c\nHidden=true'))).toBeUndefined()
    expect(parseDesktopEntry('d', entry('Exec=d'))).toBeUndefined()
    expect(parseDesktopEntry('e', entry('Name=E'))).toBeUndefined()
    expect(parseDesktopEntry('f', entry('Name=F\nExec=f\nOnlyShowIn=GNOME;'))).toBeUndefined()
    expect(parseDesktopEntry('g', entry('Name=G\nExec=g\nNotShowIn=ecmaOS;'))).toBeUndefined()
  })

  it('shows an entry limited to ecmaOS', () => {
    expect(parseDesktopEntry('h', entry('Name=H\nExec=h\nOnlyShowIn=GNOME;ecmaOS;'))?.name).toBe('H')
  })

  it('ignores other groups, comments and localized keys', () => {
    const text = '# a comment\n[Desktop Entry]\nType=Application\nName=I\nName[de]=Ei\nExec=i\n\n[Desktop Action new]\nName=New\nExec=i --new\n'
    expect(parseDesktopEntry('i', text)).toMatchObject({ name: 'I', exec: 'i' })
  })

  it('unescapes values', () => {
    expect(parseDesktopEntry('j', entry('Name=A\\sB\nExec=j'))?.name).toBe('A B')
  })
})

describe('stripFieldCodes', () => {
  it('removes field codes and keeps a literal percent', () => {
    expect(stripFieldCodes('app --open %f --class %c')).toBe('app --open --class')
    expect(stripFieldCodes('printf 100%%')).toBe('printf 100%')
    expect(stripFieldCodes('app %U')).toBe('app')
  })
})
