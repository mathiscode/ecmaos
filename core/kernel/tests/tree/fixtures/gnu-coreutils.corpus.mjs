/**
 * Inputs and commands for comparing ecmaOS coreutils with GNU's. `generate-gnu-coreutils.mjs` runs each command with the real
 * tools to make `gnu-coreutils.golden.json`; `gnu-coreutils.test.ts` runs the same commands here and compares. Each command runs
 * in a directory holding exactly these files, so the output names them the same way.
 */

const bytes = text => Uint8Array.from(text, char => char.charCodeAt(0))

/** File name to content as a latin1 string (one char per byte) */
export const files = {
  'a.txt': 'one two\nthree  four five\n\nlast line no newline',
  'b.txt': 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\n',
  'u.txt': 'h\xc3\xa9llo w\xc3\xb6rld\n\ttabbed\tline\ncaf\xc3\xa9\n',
  'empty.txt': '',
  'bin.dat': 'The quick brown fox jumps over the lazy dog, twice over: abc\x00\x01\xff\n',
  'nums.txt': '10\n9\n2\n33\n2\n100\n-5\n',
  'dup.txt': 'a\na\nb\nB\nb\nc\nc\nc\na\n',
  'words.txt': 'banana\nApple\ncherry\napple\nBanana\n',
  'csv.txt': 'name,age,city\nann,30,nyc\nbob,25,la\ncarl,100,sf\n',
  'tabs.txt': 'a\tb\tc\n1\t2\t3\nno tabs here\n',
  'crlf.txt': 'one\r\ntwo\r\n',
  'long.txt': 'The quick brown fox jumps over the lazy dog and keeps running through the forest until night falls\n'
}

export const buffers = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, bytes(text)]))

export const cases = [
  // head
  'head a.txt', 'head b.txt', 'head -n 2 a.txt', 'head -n2 a.txt', 'head -n -1 a.txt', 'head -n -20 a.txt', 'head -c 5 a.txt', 'head -c -3 a.txt', 'head -n 0 a.txt', 'head -2 a.txt',
  'head a.txt u.txt', 'head -q a.txt u.txt', 'head -v a.txt', 'head -n 1 nonexist.txt', 'head -n 1 nonexist.txt a.txt', 'cat a.txt | head -n 2', 'head -n 100 empty.txt', 'head -n 3 u.txt', 'head -c 3 u.txt',
  'head --lines=2 a.txt', 'head --bytes=4 a.txt', 'head -n 1 dir', 'head -c 1K long.txt', 'head -n 2 - < a.txt',
  // tail
  'tail a.txt', 'tail b.txt', 'tail -n 2 a.txt', 'tail -n2 a.txt', 'tail -n +2 a.txt', 'tail -n +1 a.txt', 'tail -c 5 a.txt', 'tail -c +5 a.txt', 'tail a.txt u.txt', 'tail -q a.txt u.txt', 'tail -v a.txt', 'tail -n 1 empty.txt',
  'cat a.txt | tail -n 1', 'tail -2 a.txt', 'tail -n 0 a.txt', 'tail -n 1 nonexist.txt', 'tail -n 100 a.txt', 'tail --lines=2 a.txt', 'tail -n 2 u.txt',
  // cat
  'cat a.txt', 'cat -n a.txt', 'cat -b a.txt', 'cat -s a.txt', 'cat -E a.txt', 'cat -T tabs.txt', 'cat -A bin.dat', 'cat -v bin.dat', 'cat a.txt u.txt', 'cat - < a.txt', 'cat nonexist.txt a.txt', 'cat dir', 'cat -n a.txt u.txt',
  'cat -nE crlf.txt', 'cat -A crlf.txt', 'cat empty.txt', 'cat --number a.txt', 'cat -e u.txt', 'cat -t tabs.txt',
  // sort
  'sort nums.txt', 'sort -n nums.txt', 'sort -r nums.txt', 'sort -nr nums.txt', 'sort -u dup.txt', 'sort -f words.txt', 'sort words.txt', 'sort -fu words.txt', 'sort -t, -k2 csv.txt', 'sort -t, -k2n csv.txt', 'sort -t, -k2,2nr csv.txt', 'sort -c nums.txt', 'sort -c b.txt',
  'sort -b a.txt', 'sort a.txt u.txt', 'sort b.txt', 'sort -k1,1 -k2,2 a.txt', 'sort -h nums.txt', 'sort -V nums.txt', 'sort -s -k1,1 dup.txt', 'sort empty.txt', 'sort nonexist.txt', 'sort -n a.txt', 'sort -d words.txt', 'sort -M words.txt',
  // uniq
  'uniq dup.txt', 'uniq -c dup.txt', 'uniq -d dup.txt', 'uniq -u dup.txt', 'uniq -i dup.txt', 'uniq -ic dup.txt', 'uniq -f 1 csv.txt', 'uniq -s 1 dup.txt', 'uniq -w 1 words.txt', 'uniq empty.txt', 'uniq -D dup.txt', 'sort dup.txt | uniq -c',
  // cut
  'cut -d, -f1 csv.txt', 'cut -d, -f2,3 csv.txt', 'cut -d, -f2- csv.txt', 'cut -d, -f-2 csv.txt', 'cut -c1-3 a.txt', 'cut -c2 a.txt', 'cut -b1-2 u.txt', 'cut -c1-2 u.txt', 'cut -f1 a.txt', 'cut -f2 tabs.txt', 'cut -s -f2 tabs.txt', 'cut -s -d, -f1 a.txt',
  'cut --complement -d, -f1 csv.txt', 'cut -d, -f1 --output-delimiter=: csv.txt', 'cut -d, -f1,3 --output-delimiter=: csv.txt', 'cut -f1 nonexist.txt', 'cut a.txt', 'cut -d, -f0 csv.txt', 'cut -c1,3,5 a.txt',
  // tr
  'cat a.txt | tr a-z A-Z', 'cat a.txt | tr -d aeiou', 'cat a.txt | tr -s " "', 'cat a.txt | tr -c a-z X', 'cat a.txt | tr "[:lower:]" "[:upper:]"', 'cat a.txt | tr -d "\\n"', 'cat a.txt | tr a-c x', 'cat a.txt | tr -cd "[:alpha:]"',
  'cat a.txt | tr abc xy', 'cat u.txt | tr a-z A-Z', 'cat tabs.txt | tr "\\t" ","', 'cat a.txt | tr -s "[:space:]"', 'cat a.txt | tr -d "[:space:]"', 'cat a.txt | tr', 'cat crlf.txt | tr -d "\\r"', 'cat a.txt | tr -t abc xy', 'cat a.txt | tr -cs "[:alpha:]" "\\n"',
  // nl, tac, rev, paste, fold
  'nl a.txt', 'nl -ba a.txt', 'nl -bt a.txt', 'nl -s: a.txt', 'nl -w3 a.txt', 'nl -n ln a.txt', 'nl -n rz a.txt', 'nl -v5 a.txt', 'nl -i2 a.txt', 'nl empty.txt', 'nl a.txt u.txt',
  'tac a.txt', 'tac nums.txt', 'tac a.txt u.txt', 'tac empty.txt', 'tac -s, csv.txt', 'tac nonexist.txt',
  'rev a.txt', 'rev u.txt', 'rev empty.txt', 'cat b.txt | rev',
  'paste a.txt b.txt', 'paste -d, nums.txt b.txt', 'paste -s nums.txt', 'paste -s -d, nums.txt', 'paste - - < nums.txt', 'paste nums.txt', 'paste -d"|" a.txt b.txt u.txt',
  'fold -w 5 a.txt', 'fold -s -w 8 a.txt', 'fold -w 20 long.txt', 'fold -sw 30 long.txt', 'fold -b -w 4 u.txt', 'fold a.txt', 'fold -w 3 u.txt'
]
