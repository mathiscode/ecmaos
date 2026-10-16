import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { strftime } from '../../src/commands-execve/lib/strftime.mjs'

const at = (format: string, ms = 1700000000000) => strftime(format, { ms, utc: true, zone: 'UTC' })

describe('strftime', () => {
  it('formats the common conversions like GNU date', () => {
    expect(at('%a%A%b%B%d%e%j%m%u%w%y%U%W%V%G%g')).toBe('TueTuesdayNovNovember1414318112223464646202323')
    expect(at('%I%p%l%k%M%S%N%Z%z')).toBe('10PM10221320000000000UTC+0000')
    expect(at('%D%F%T%R%r%x%X%h%n%t%%')).toBe('11/14/232023-11-1422:13:2022:1310:13:20 PM11/14/2322:13:20Nov\n\t%')
    expect(at('%c')).toBe('Tue Nov 14 22:13:20 2023')
    expect(at('%s')).toBe('1700000000')
  })
  it('handles flags, widths and colon zones', () => {
    expect(at('%-d%_d%^a%10Y%05e%:z%::z', 1700000000000)).toBe('1414TUE000000202300014+00:00+00:00:00')
    expect(at('%-d', 1699000000000)).toBe('3')
    expect(at('%3N', 1700000000123)).toBe('123')
  })
  it('leaves an unknown conversion as written', () => {
    expect(at('%q')).toBe('%q')
  })
})
