import { describe, expect, it } from 'vitest'

import { echoOutput } from '../../src/lib/echo-text.ts'

describe('echoOutput', () => {
  it('joins the operands and ends with a newline', () => {
    expect(echoOutput(['a', 'b']).output).toBe('a b\n')
    expect(echoOutput([]).output).toBe('\n')
  })

  it('-n drops the newline and -e reads escapes, until an operand ends the options', () => {
    expect(echoOutput(['-n', 'x']).output).toBe('x')
    expect(echoOutput(['-e', 'a\\tb\\n']).output).toBe('a\tb\n\n')
    expect(echoOutput(['-ne', 'a\\x41\\0101\\101']).output).toBe('aAA\\101')
    expect(echoOutput(['hi', '-n']).output).toBe('hi -n\n')
    expect(echoOutput(['-x', 'y']).output).toBe('-x y\n')
  })

  it('-E turns escapes back off, and \\c stops all output', () => {
    expect(echoOutput(['-eE', 'a\\n']).output).toBe('a\\n\n')
    expect(echoOutput(['-e', 'ab\\cde']).output).toBe('ab')
  })

  it('treats --help as text unless the program asks for help', () => {
    expect(echoOutput(['--help']).output).toBe('--help\n')
    expect(echoOutput(['--help'], { stopAtHelp: true }).help).toBe(true)
  })
})
