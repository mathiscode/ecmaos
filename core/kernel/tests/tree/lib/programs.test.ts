import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { installPrograms } from '#lib/programs.ts'
import type { ProgramCatalog } from '#lib/programs.ts'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Just the corner of the filesystem that `installPrograms` touches. */
function fakeFs(files: Record<string, Uint8Array | { link: string }> = {}) {
  const stat = (path: string) => {
    const file = files[path]
    if (!file) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const link = !(file instanceof Uint8Array)
    return Promise.resolve({ isFile: () => !link, isSymbolicLink: () => link, size: link ? 0 : (file as Uint8Array).length })
  }
  return {
    files,
    stat, lstat: stat,
    unlink: (path: string) => { delete files[path]; return Promise.resolve() },
    writeFile: (path: string, data: Uint8Array) => { files[path] = data; return Promise.resolve() }
  } as any
}

function setup(programs: Record<string, Uint8Array>, options: { missing?: string[], corrupt?: string[] } = {}) {
  const catalog: ProgramCatalog = {
    packages: [{
      name: '@ecmaos/coreutils-test', path: 'test',
      programs: Object.fromEntries(Object.entries(programs).map(([name, bytes]) => [name, { file: `${name}.wasm`, size: bytes.length, sha256: sha256(bytes), version: '1', license: 'MIT', description: name }]))
    }]
  }
  const requests: string[] = []
  const fetcher = (url: string) => {
    requests.push(url)
    if (url.endsWith('index.json')) return Promise.resolve(new Response(JSON.stringify(catalog)))
    const name = /\/test\/(\w+)\.wasm/.exec(url)?.[1] ?? ''
    if (options.missing?.includes(name)) return Promise.resolve(new Response('no', { status: 404 }))
    const bytes = options.corrupt?.includes(name) ? new Uint8Array(programs[name]!.map(byte => byte ^ 1)) : programs[name]!
    return Promise.resolve(new Response(bytes))
  }
  let stamps: Record<string, string> = {}
  return { requests, fetcher, stamps: { read: () => ({ ...stamps }), write: (next: Record<string, string>) => { stamps = next } }, current: () => stamps }
}

const a = new Uint8Array([0, 0x61, 0x73, 0x6d, 1])
const b = new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 3])

describe('installPrograms', () => {
  it('writes each program and records what it wrote', async () => {
    const env = setup({ alpha: a, beta: b })
    const fs = fakeFs()
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    expect(result.installed.sort()).toEqual(['alpha', 'beta'])
    expect(fs.files['/bin/alpha']).toEqual(a)
    expect(Object.keys(env.current()).sort()).toEqual(['alpha', 'beta'])
  })

  it('fetches nothing on the next boot, and again when the catalog changes', async () => {
    const env = setup({ alpha: a })
    const fs = fakeFs()
    await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    env.requests.length = 0
    const again = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    expect(again.current).toEqual(['alpha'])
    expect(env.requests).toEqual(['http://x/programs/index.json'])

    const upgraded = setup({ alpha: b })
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: upgraded.fetcher })
    expect(result.installed).toEqual(['alpha'])
    expect(fs.files['/bin/alpha']).toEqual(b)
  })

  it('puts a program back when it was deleted', async () => {
    const env = setup({ alpha: a })
    const fs = fakeFs()
    await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    delete fs.files['/bin/alpha']
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    expect(result.installed).toEqual(['alpha'])
  })

  it('names the hash a version in the URL, so a changed program is never served from cache', async () => {
    const env = setup({ alpha: a })
    await installPrograms(fakeFs(), { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    expect(env.requests[1]).toBe(`http://x/programs/test/alpha.wasm?v=${sha256(a).slice(0, 16)}`)
  })

  it('reports a bad program and still installs the rest', async () => {
    const env = setup({ alpha: a, beta: b, gamma: new Uint8Array([9, 9]) }, { missing: ['alpha'], corrupt: ['gamma'] })
    const fs = fakeFs()
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: env.stamps, fetcher: env.fetcher })
    expect(result.installed).toEqual(['beta'])
    expect(Object.keys(result.failed).sort()).toEqual(['alpha', 'gamma'])
    expect(fs.files['/bin/alpha']).toBeUndefined()
    expect(fs.files['/bin/gamma']).toBeUndefined()
  })

  it('leaves what is installed alone when the catalog cannot be fetched', async () => {
    const fs = fakeFs({ '/bin/alpha': a })
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', stamps: { read: () => ({}), write: () => {} }, fetcher: () => Promise.resolve(new Response('', { status: 503 })) })
    expect(result.installed).toEqual([])
    expect(result.failed['(catalog)']).toContain('503')
    expect(fs.files['/bin/alpha']).toEqual(a)
  })

  it('skips blacklisted names, and replaces a link with the program', async () => {
    const env = setup({ alpha: a, vim: b })
    const fs = fakeFs({ '/bin/vim': { link: 'vi' } })
    const result = await installPrograms(fs, { catalogUrl: 'http://x/programs/index.json', skip: name => name === 'alpha', stamps: env.stamps, fetcher: env.fetcher })
    expect(result.installed).toEqual(['vim'])
    expect(fs.files['/bin/alpha']).toBeUndefined()
    expect(fs.files['/bin/vim']).toEqual(b)
  })
})
