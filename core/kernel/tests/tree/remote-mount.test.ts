import { describe, expect, it } from 'vitest'

import { publicKeyOf } from '@ecmaos/peer'

import { findKnownHost, knownHostLine } from '#lib/known-hosts.ts'
import { DefaultLimits, parseRemoteSource, parseSize } from '#lib/remote-mount.ts'

describe('mount -t ecmaos sources', () => {
  it('reads [user@]host[:port][/export]', () => {
    expect(parseRemoteSource('alice@example.org:4000/share', 'me')).toEqual({ user: 'alice', host: 'example.org', port: 4000, name: 'share', tls: false })
    expect(parseRemoteSource('127.0.0.1/data', 'me')).toEqual({ user: 'me', host: '127.0.0.1', port: 30022, name: 'data', tls: false })
    expect(parseRemoteSource('root@host', 'me')).toEqual({ user: 'root', host: 'host', port: 30022, name: '', tls: false })
    expect(parseRemoteSource('root@[::1]:30022/a/b', 'me')).toMatchObject({ host: '[::1]', name: 'a/b' })
  })

  it('wss:// marks a host that serves TLS (and ws:// is the plain default)', () => {
    expect(parseRemoteSource('wss://root@example.org:443/share', 'me')).toEqual({ user: 'root', host: 'example.org', port: 443, name: 'share', tls: true })
    expect(parseRemoteSource('wss://example.org', 'me')).toMatchObject({ user: 'me', port: 30022, tls: true })
    expect(parseRemoteSource('ws://example.org', 'me')).toMatchObject({ tls: false })
  })

  it('refuses what is not one', () => {
    for (const bad of ['', '@host', 'host:0', 'host:70000', 'host:abc', 'a b', '/share']) expect(parseRemoteSource(bad, 'me'), bad).toBeNull()
  })

  it('reads sizes', () => {
    expect([parseSize('65536'), parseSize('50M'), parseSize('2g'), parseSize('1k')]).toEqual([65536, 50 << 20, 2 * 1024 ** 3, 1024])
    for (const bad of ['', 'M', '-1', '1.5M', '10X']) expect(parseSize(bad), bad).toBeNull()
  })

  it('refuses a tree of more than 5000 files or 50 MB unless told otherwise', () => {
    expect(DefaultLimits).toEqual({ files: 5000, bytes: 50 << 20 })
  })
})

describe('known_hosts', () => {
  const key = publicKeyOf({ kty: 'EC', crv: 'P-384', x: 'x'.repeat(64), y: 'y'.repeat(64) })!

  it('writes a line that finds the key again, for that host only', () => {
    const text = knownHostLine('127.0.0.1:30022', key)
    expect(text.endsWith('\n')).toBe(true)
    expect(findKnownHost(text, '127.0.0.1:30022')).toEqual(key)
    expect(findKnownHost(text, '127.0.0.1:30023')).toBeNull()
    expect(findKnownHost(text, 'localhost:30022')).toBeNull()
  })

  it('skips lines it cannot read and finds the right one among several', () => {
    const other = publicKeyOf({ kty: 'EC', crv: 'P-384', x: 'a'.repeat(64), y: 'b'.repeat(64) })!
    const text = `garbage\n# comment\nhost:1 ssh-rsa AAAA\nhost:2 ecdsa-p384 !!notbase64!!\n${knownHostLine('host:3', other)}${knownHostLine('host:4', key)}`
    expect(findKnownHost(text, 'host:4')).toEqual(key)
    expect(findKnownHost(text, 'host:3')).toEqual(other)
    expect(findKnownHost(text, 'host:2')).toBeNull()
  })
})
