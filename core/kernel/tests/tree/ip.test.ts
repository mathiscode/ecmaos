import { describe, expect, it } from 'vitest'
import { canonicalIp, formatIp, isLoopbackIp, parseIp, parseIPv6 } from '#lib/ip.ts'

describe('ip addresses', () => {
  it('carries IPv4 as the mapped 16 bytes and prints it as a dotted quad', () => {
    const bytes = parseIp('10.1.2.3')!
    expect([...bytes.slice(10)]).toEqual([0xff, 0xff, 10, 1, 2, 3])
    expect(formatIp(bytes)).toBe('10.1.2.3')
  })

  it('spells one IPv6 address one way', () => {
    expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(canonicalIp('::1')).toBe('::1')
    expect(canonicalIp('::')).toBe('::')
    expect(canonicalIp('fe80::1%eth0')).toBe('fe80::1')
    expect(canonicalIp('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3') // the longest run of zeros wins
    expect(canonicalIp('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7') // a single zero group is not shortened
  })

  it('folds an IPv4-mapped address into the IPv4 one', () => {
    expect(canonicalIp('::ffff:192.0.2.9')).toBe('192.0.2.9')
    expect(canonicalIp('::ffff:c000:209')).toBe('192.0.2.9')
    expect(canonicalIp('::ffff:0.0.0.0')).toBe('0.0.0.0')
  })

  it('refuses what is not an address', () => {
    for (const text of ['', 'localhost', '1.2.3', '256.1.1.1', ':::', '1::2::3', '12345::', '1:2:3:4:5:6:7:8:9', '::g', '1:2:3:4:5:6:7']) expect(parseIp(text), text).toBeUndefined()
    expect(parseIPv6('1.2.3.4')).toBeUndefined()
  })

  it('knows which addresses are this machine', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '::1', '::']) expect(isLoopbackIp(address)).toBe(true)
    for (const address of ['127.0.0.2', '::2', '10.0.0.1']) expect(isLoopbackIp(address)).toBe(false)
  })
})
