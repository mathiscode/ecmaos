import { describe, expect, it } from 'vitest'

import { parseScript } from '../../../src/lib/shell-parser.ts'
import { parseArrayAssignment, splitAssignments } from '../../../src/lib/shell-core/prepare.ts'

const command = (text: string) => parseScript(text).stages[0]!.pipeline.commands[0]!

describe('splitAssignments', () => {
  it('lifts leading assignments and leaves the command', () => {
    const { assignments, command: rest } = splitAssignments(command('A=1 B="x y" env -i'))
    expect(assignments.map(a => [a.name, a.append])).toEqual([['A', false], ['B', false]])
    expect(rest.words).toEqual(['env', '-i'])
  })

  it('reports a bare assignment line as assignments with no command', () => {
    const { assignments, command: rest } = splitAssignments(command('X=1 Y=2'))
    expect(assignments).toHaveLength(2)
    expect(rest.words).toEqual([])
  })

  it('knows +=', () => {
    const { assignments } = splitAssignments(command('s+=more'))
    expect(assignments[0]).toMatchObject({ name: 's', append: true })
    expect(assignments[0]!.parts[0]!.text).toBe('more')
  })

  it('a quoted = is a command word, not an assignment', () => {
    expect(splitAssignments(command('"X=1" cmd')).assignments).toEqual([])
  })
})

describe('parseArrayAssignment', () => {
  it('reads a list with a ) inside a quote and what follows it', () => {
    expect(parseArrayAssignment("a=(x 'y)' z); echo hi")).toEqual({ kind: 'list', name: 'a', append: false, local: false, body: "x 'y)' z", operator: ';', rest: 'echo hi' })
  })

  it('reads +=( and elements', () => {
    expect(parseArrayAssignment('local a=(1)')).toMatchObject({ local: true, name: 'a' })
    expect(parseArrayAssignment('a+=(z)')).toMatchObject({ kind: 'list', append: true })
    expect(parseArrayAssignment('a[2+1]=v && next')).toMatchObject({ kind: 'element', name: 'a', subscript: '2+1', raw: 'v', operator: '&&', rest: 'next' })
  })

  it('is undefined for anything else', () => {
    expect(parseArrayAssignment('echo (x)')).toBeUndefined()
    expect(parseArrayAssignment('a=(x) trailing')).toBeUndefined()
  })
})
