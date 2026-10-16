import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { runPr } from '../../src/commands-execve/lib/pr-render.mjs'
// @ts-expect-error plain JS module
import { getopt } from '../../src/commands-execve/lib/getopt.mjs'

const FILES: Record<string, string> = {"a.txt": "one two\nthree  four five\n\nlast line no newline", "b.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\n", "pr.txt": "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\n", "tabs.txt": "a\tb\tc\n1\t2\t3\nno tabs here\n", "n3.txt": "one\ntwo\nthree\n"}
const CASES: Array<[string, string]> = [["-t -2 b.txt", "alpha\t\t\t\t    eta\nbeta\t\t\t\t    theta\ngamma\t\t\t\t    iota\ndelta\t\t\t\t    kappa\nepsilon\t\t\t\t    lambda\nzeta\t\t\t\t    mu\n"], ["-t -3 b.txt", "alpha\t\t\tepsilon\t\t\tiota\nbeta\t\t\tzeta\t\t\tkappa\ngamma\t\t\teta\t\t\tlambda\ndelta\t\t\ttheta\t\t\tmu\n"], ["-t -a -3 b.txt", "alpha\t\t\tbeta\t\t\tgamma\ndelta\t\t\tepsilon\t\t\tzeta\neta\t\t\ttheta\t\t\tiota\nkappa\t\t\tlambda\t\t\tmu\n"], ["-t -m a.txt b.txt", "one two\t\t\t\t    alpha\nthree  four five\t\t    beta\n\t\t\t\t    gamma\nlast line no newline\t\t    delta\n\t\t\t\t    epsilon\n\t\t\t\t    zeta\n\t\t\t\t    eta\n\t\t\t\t    theta\n\t\t\t\t    iota\n\t\t\t\t    kappa\n\t\t\t\t    lambda\n\t\t\t\t    mu\n"], ["-t -5 pr.txt", "line 1\t      line 4\t    line 7\t  line 9\tline 11\nline 2\t      line 5\t    line 8\t  line 10\tline 12\nline 3\t      line 6\n"], ["-t -n a.txt", "    1\tone two\n    2\tthree  four five\n    3\t\n    4\tlast line no newline\n"], ["-t -d a.txt", "one two\n\nthree  four five\n\n\n\nlast line no newline\n"], ["-t -o 4 a.txt", "    one two\n    three  four five\n    \n    last line no newline\n"], ["-t -s: -2 b.txt", "alpha:eta\nbeta:theta\ngamma:iota\ndelta:kappa\nepsilon:lambda\nzeta:mu\n"], ["-t -e4 tabs.txt", "a   b   c\n1   2   3\nno tabs here\n"], ["-t -i tabs.txt", "a\tb\tc\n1\t2\t3\nno tabs here\n"], ["-l 14 pr.txt", "\n\n2020-01-02 09:04                      pr.txt                      Page 1\n\n\nline 1\nline 2\nline 3\nline 4\n\n\n\n\n\n\n\n2020-01-02 09:04                      pr.txt                      Page 2\n\n\nline 5\nline 6\nline 7\nline 8\n\n\n\n\n\n\n\n2020-01-02 09:04                      pr.txt                      Page 3\n\n\nline 9\nline 10\nline 11\nline 12\n\n\n\n\n\n"], ["-F -l 12 pr.txt", "\n\n2020-01-02 09:04                      pr.txt                      Page 1\n\n\nline 1\nline 2\n\f\n\n2020-01-02 09:04                      pr.txt                      Page 2\n\n\nline 3\nline 4\n\f\n\n2020-01-02 09:04                      pr.txt                      Page 3\n\n\nline 5\nline 6\n\f\n\n2020-01-02 09:04                      pr.txt                      Page 4\n\n\nline 7\nline 8\n\f\n\n2020-01-02 09:04                      pr.txt                      Page 5\n\n\nline 9\nline 10\n\f\n\n2020-01-02 09:04                      pr.txt                      Page 6\n\n\nline 11\nline 12\n\f"], ["-h HH -o 3 -l 12 n3.txt", "   \n\n   2020-01-02 09:04                        HH                        Page 1\n\n\n   one\n   two\n\n\n\n\n\n   \n\n   2020-01-02 09:04                        HH                        Page 2\n\n\n   three\n\n\n\n\n\n\n"], ["-t -2 -n b.txt", "    1\talpha\t\t\t    \t7   eta\n    2\tbeta\t\t\t    \t8   theta\n    3\tgamma\t\t\t    \t9   iota\n    4\tdelta\t\t\t       10   kappa\n    5\tepsilon\t\t\t       11   lambda\n    6\tzeta\t\t\t       12   mu\n"]]
const MTIME = 1577955845000

const host = {
  readFile(name: string) {
    if (!(name in FILES)) throw Object.assign(new Error('No such file or directory'), { reason: 'No such file or directory' })
    return { content: FILES[name], mtime: MTIME }
  },
  readStdin: () => '',
  now: () => MTIME,
  utc: true,
  zone: 'UTC'
}

const run = (command: string) => runPr(command.split(' '), host, getopt)

describe('pr', () => {
  // each expected output was produced by GNU pr 9.11 on the same files (TZ=UTC)
  for (const [command, expected] of CASES) {
    it(`pr ${command}`, () => {
      const result = run(command)
      expect(result.out).toBe(expected)
      expect(result.status).toBe(0)
    })
  }

  it('reports a missing file and goes on', () => {
    const result = runPr(['-t', 'a.txt', 'nope.txt'], host, getopt)
    expect(result.err).toBe('pr: nope.txt: No such file or directory\n')
    expect(result.status).toBe(1)
    expect(result.out.length).toBeGreaterThan(0)
  })

  it('refuses -m with a column count', () => {
    expect(run('-m -2 a.txt b.txt').err).toBe('pr: cannot specify number of columns when printing in parallel\n')
  })

  it('takes digits in consecutive options as one number', () => {
    expect(run('-t -1 -2 -7 b.txt').err).toBe('pr: page width too narrow\n')
  })
})
