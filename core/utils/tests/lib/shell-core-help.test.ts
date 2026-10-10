import { describe, expect, it } from 'vitest'

import { sharedBuiltinNames } from '../../src/lib/shell-core/builtins.ts'
import { helpOverview, helpTopic, helpTopicNames, matchHelpTopics } from '../../src/lib/shell-core/help.ts'
import { formatSelectMenu } from '../../src/lib/shell-core/select-menu.ts'

describe('help topics', () => {
  it('describe every builtin the shells share, so a new one cannot be left out of help', () => {
    const missing = [...sharedBuiltinNames].filter(name => !helpTopic(name))
    expect(missing).toEqual([])
  })

  it('match by name, by glob, and not at all', () => {
    expect(matchHelpTopics('cd')).toEqual(['cd'])
    expect(matchHelpTopics('p*d')).toEqual(['popd', 'pushd', 'pwd'])
    expect(matchHelpTopics('[ab]g')).toEqual(['bg'])
    expect(matchHelpTopics('nosuchbuiltin')).toEqual([])
  })

  it('list every topic in the overview', () => {
    const overview = helpOverview()
    for (const name of helpTopicNames) expect(overview).toContain((helpTopic(name) as { synopsis: string }).synopsis.slice(0, 20))
  })
})

describe('select menu layout', () => {
  it('is one column when the entries fit on a single row', () => {
    expect(formatSelectMenu(['a', 'b', 'c'])).toBe('1) a\n2) b\n3) c\n')
  })

  it('runs down the columns, padding with tabs where a tab stop fits', () => {
    const menu = formatSelectMenu(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'])
    expect(menu).toBe('1) alpha      3) gamma\t   5) epsilon   7) eta\t     9) iota\n2) beta\t      4) delta\t   6) zeta      8) theta    10) kappa\n')
  })

  it('uses fewer columns in a narrow terminal', () => {
    expect(formatSelectMenu(['aaaaaaaa', 'bbbbbbbbb', 'cccccccccc', 'dddddddd', 'eeeeee'], 30))
      .toBe('1) aaaaaaaa    4) dddddddd\n2) bbbbbbbbb   5) eeeeee\n3) cccccccccc\n')
  })
})
