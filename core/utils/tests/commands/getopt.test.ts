import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { getopt } from '../../src/commands-execve/lib/getopt.mjs'
// @ts-expect-error plain JS module
import { codeOf, reasonOf } from '../../src/commands-execve/lib/errno.mjs'

const spec = { short: 'rRfvo:', long: { recursive: 'r', force: 'f', verbose: 'v', output: { key: 'o', arg: 'required' }, 'no-clobber': 'n', 'no-dereference': 'h' }, permute: true }

describe('getopt', () => {
  it('splits clustered short options and operands', () => {
    expect(getopt(['-rf', 'a', 'b'], spec)).toEqual({ options: [['r', true], ['f', true]], operands: ['a', 'b'] })
  })
  it('permutes operands among options unless told not to', () => {
    expect(getopt(['a', '-r', 'b'], spec).operands).toEqual(['a', 'b'])
    expect(getopt(['a', '-r', 'b'], { ...spec, permute: false })).toEqual({ options: [], operands: ['a', '-r', 'b'] })
  })
  it('stops at --', () => {
    expect(getopt(['-r', '--', '-f', 'x'], spec)).toEqual({ options: [['r', true]], operands: ['-f', 'x'] })
  })
  it('treats a lone - as an operand', () => {
    expect(getopt(['-'], spec).operands).toEqual(['-'])
  })
  it('takes an attached or separate option argument', () => {
    expect(getopt(['-ofile'], spec).options).toEqual([['o', 'file']])
    expect(getopt(['-o', 'file'], spec).options).toEqual([['o', 'file']])
    expect(getopt(['-rofile'], spec).options).toEqual([['r', true], ['o', 'file']])
  })
  it('takes a long option argument with = or separately, and abbreviations', () => {
    expect(getopt(['--output=x'], spec).options).toEqual([['o', 'x']])
    expect(getopt(['--output', 'x'], spec).options).toEqual([['o', 'x']])
    expect(getopt(['--rec'], spec).options).toEqual([['r', true]])
  })
  it('reports errors in the GNU wording', () => {
    expect(getopt(['-z'], spec).error).toBe("invalid option -- 'z'")
    expect(getopt(['--zap'], spec).error).toBe("unrecognized option '--zap'")
    expect(getopt(['-o'], spec).error).toBe("option requires an argument -- 'o'")
    expect(getopt(['--output'], spec).error).toBe("option '--output' requires an argument")
    expect(getopt(['--force=1'], spec).error).toBe("option '--force' doesn't allow an argument")
    expect(getopt(['--no'], spec).error).toBe("option '--no' is ambiguous; possibilities: '--no-clobber' '--no-dereference'")
  })
})

describe('errno', () => {
  it('names the code and gives the GNU reason', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(codeOf(new Error("ENOTEMPTY: directory not empty, rmdir '/a'"))).toBe('ENOTEMPTY')
    expect(reasonOf(new Error('EEXIST: file already exists'))).toBe('File exists')
    expect(reasonOf(new Error('odd'))).toBe('odd')
  })
})
