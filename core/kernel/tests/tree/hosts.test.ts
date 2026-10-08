import { describe, expect, it } from 'vitest'

import { DEFAULT_HOSTS, isIPv4, lookupHosts } from '#lib/hosts.ts'
import { LookupFailure, resolveHostname } from '#lib/remote-gateway.ts'
import type { Kernel } from '#kernel.ts'

describe('/etc/hosts', () => {
  it('finds a name by any of its aliases, case-insensitively, in the family asked for', () => {
    const text = '# comment\n127.0.0.1 localhost\n::1 localhost ip6-localhost\n10.0.0.7 Web.Example  www # trailing\nbad line\n'
    expect(lookupHosts(text, 'LOCALHOST', 4)).toEqual(['127.0.0.1'])
    expect(lookupHosts(text, 'localhost', 6)).toEqual(['::1'])
    expect(lookupHosts(text, 'www', 4)).toEqual(['10.0.0.7'])
    expect(lookupHosts(text, 'web.example.', 4)).toEqual(['10.0.0.7'])
    expect(lookupHosts(text, 'www', 6)).toEqual([])
    expect(lookupHosts(text, 'missing', 4)).toEqual([])
  })

  it('lists every address a name has, in file order', () => {
    expect(lookupHosts('1.1.1.1 a\n2.2.2.2 a\n', 'a', 4)).toEqual(['1.1.1.1', '2.2.2.2'])
  })

  it('ships localhost', () => {
    expect(lookupHosts(DEFAULT_HOSTS, 'localhost', 4)).toEqual(['127.0.0.1'])
  })

  it('reads dotted quads', () => {
    expect(['1.2.3.4', '255.255.255.255', '0.0.0.0'].every(isIPv4)).toBe(true)
    expect(['1.2.3', '256.1.1.1', 'a.b.c.d', '1.2.3.4.5', '::1'].some(isIPv4)).toBe(false)
  })
})

describe('resolving a name without a gateway', () => {
  const kernel = (hosts?: string) => ({
    filesystem: { fs: { exists: async () => hosts !== undefined, readFile: async () => hosts } }
  }) as unknown as Kernel

  it('answers a literal, then the hosts file', async () => {
    expect(await resolveHostname(kernel(), '10.1.2.3')).toEqual(['10.1.2.3'])
    expect(await resolveHostname(kernel('10.0.0.9 box\n'), 'box')).toEqual(['10.0.0.9'])
    expect(await resolveHostname(kernel(), 'localhost')).toEqual(['127.0.0.1']) // the built-in table when there is no file
  })

  it('is a temporary failure for anything else, as with no nameserver', async () => {
    const error = await resolveHostname(kernel('127.0.0.1 localhost\n'), 'example.com').catch(error => error)
    expect(error).toBeInstanceOf(LookupFailure)
    expect(error.kind).toBe('AGAIN')
  })
})
