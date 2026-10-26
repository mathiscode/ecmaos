import { describe, expect, it } from 'vitest'

import { ModuleCatalog } from '#lib/module-catalog.ts'
import type { ModuleCatalogHost } from '#lib/module-catalog.ts'

const host = (fetch: ModuleCatalogHost['fetch']) => {
  const warnings: string[] = []
  const catalog = new ModuleCatalog({
    url: '/modules/index.json',
    fetch,
    dir: () => '/lib/modules/test',
    fs: { mkdir: async () => undefined, writeFile: async () => undefined },
    log: { warn: message => { warnings.push(message) } }
  })
  return { catalog, warnings }
}

const entry = { file: 'zip.ko.mjs', size: 1, sha256: 'x', version: '1', license: 'MIT', description: '', aliases: ['fs-zip'], depends: [], signed: false }

describe('module catalog', () => {
  it('says why the catalog could not be fetched, and tries again next time', async () => {
    let calls = 0
    const { catalog, warnings } = host(async () => {
      calls++
      if (calls === 1) throw new Error('timed out')
      if (calls === 2) return new Response('', { status: 503, statusText: 'Service Unavailable' })
      return Response.json({ modules: { zip: entry } })
    })
    expect(await catalog.find('fs-zip')).toBeUndefined()
    expect(warnings).toEqual(['module catalog /modules/index.json: timed out'])
    expect(await catalog.find('fs-zip')).toBeUndefined()
    expect(warnings[1]).toBe('module catalog /modules/index.json: 503 Service Unavailable')
    expect(await catalog.find('fs-zip')).toBe('zip')
    expect(warnings).toHaveLength(2)
  })

  it('stays quiet about a type the catalog does not have', async () => {
    const { catalog, warnings } = host(async () => Response.json({ modules: { zip: entry } }))
    expect(await catalog.find('fs-nonesuch')).toBeUndefined()
    expect(warnings).toEqual([])
  })
})
