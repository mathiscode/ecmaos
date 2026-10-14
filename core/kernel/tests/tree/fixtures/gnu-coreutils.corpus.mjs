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
  'c.txt': 'apple\nbanana\ncherry\ndate\n',
  'd.txt': 'banana\ncherry\nelder\nfig\n',
  'spaces.txt': '        x\n    y    z\n\t\tw\n  \tv\n',
  'j1.txt': '1 a\n2 b\n3 c\n5 e\n',
  'j2.txt': '1 x\n3 y\n4 z\n5 w\n',
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
  'fold -w 5 a.txt', 'fold -s -w 8 a.txt', 'fold -w 20 long.txt', 'fold -sw 30 long.txt', 'fold -b -w 4 u.txt', 'fold a.txt', 'fold -w 3 u.txt',

  // seq, basename, dirname
  'seq 3', 'seq 2 5', 'seq 1 2 9', 'seq 5 -1 1', 'seq -s, 3', 'seq -w 8 11', 'seq 0.5 0.5 2', 'seq -f "%02g" 3', 'seq 3 1', 'seq a', 'seq 1 0 3', 'seq -s " " 2 4', 'seq 10 5 30', 'seq -f "%.2f" 1 0.25 2',
  'basename /a/b/c.txt', 'basename /a/b/c.txt .txt', 'basename -s .txt /a/c.txt /b/d.txt', 'basename /', 'basename ""', 'basename a/b/', 'basename -a x/y z/w', 'basename c.txt c.txt', 'basename -s .txt c.txt', 'basename a//b//',
  'dirname /a/b/c', 'dirname a', 'dirname /', 'dirname a/b/', 'dirname /a', 'dirname a/b c/d/e', 'dirname ""', 'dirname a//b', 'dirname ///a',
  // printf and echo
  'printf "%s\\n" a b c', 'printf "%d %5.2f %x %o %c\\n" 42 3.14159 255 8 hello', 'printf "%-5s|%5s|\\n" ab cd', 'printf "%05d\\n" 42', 'printf "%s\\n"', 'printf "a\\tb\\n"', 'printf "%b\\n" "a\\nb"', 'printf "%%\\n"', 'printf "%d\\n" abc', 'printf "%.3s\\n" abcdef',
  'printf "%e\\n" 1234.5', 'printf "%+d\\n" 5', 'printf "\\x41\\101\\n"', 'printf "%s %s\\n" a', 'printf "%5s|\\n" abcdefg', 'printf "%X %#x %#o\\n" 255 255 8', 'printf "%u\\n" -1', 'printf "%i\\n" 7', 'printf "%g %g\\n" 0.0001 1000000', 'printf "%c%c\\n" ab cd', 'printf "%s\\n" "a b" c',
  'echo hi', 'echo -n hi', 'echo -e "a\\tb"', 'echo -E "a\\tb"', 'echo -ne "x\\n"', 'echo', 'echo a  b', 'echo -e "\\x41\\0102"', 'echo -e "a\\cb"', 'echo "*"',
  // comm, cmp
  'comm c.txt d.txt', 'comm -12 c.txt d.txt', 'comm -23 c.txt d.txt', 'comm -13 c.txt d.txt', 'comm --output-delimiter=: c.txt d.txt', 'comm -1 c.txt d.txt', 'comm -3 c.txt d.txt', 'comm c.txt empty.txt', 'comm c.txt nonexist.txt',
  'cmp a.txt a.txt', 'cmp a.txt b.txt', 'cmp -s a.txt b.txt', 'cmp -l a.txt u.txt', 'cmp a.txt empty.txt', 'cmp a.txt nonexist.txt', 'cmp -n 3 a.txt u.txt', 'cmp c.txt d.txt', 'cmp -b c.txt d.txt', 'cmp -i 1 c.txt d.txt',
  // od, expand, unexpand
  'od a.txt', 'od -An -tx1 a.txt', 'od -c u.txt', 'od -An -N4 -tu1 bin.dat', 'od -b a.txt', 'od -x u.txt', 'od -A x -t x1 a.txt', 'od -j 3 -N 5 -c a.txt', 'od -An -td2 nums.txt', 'od -An -c tabs.txt', 'od -A n -t a bin.dat', 'od -t x2 -N 6 a.txt', 'od empty.txt', 'od -A d -c a.txt', 'od -v -An -tx1 -N 4 a.txt',
  'expand tabs.txt', 'expand -t 4 tabs.txt', 'expand -i tabs.txt', 'expand -t 2,6 tabs.txt', 'expand spaces.txt', 'expand -t 3 spaces.txt', 'expand empty.txt',
  'unexpand spaces.txt', 'unexpand -a spaces.txt', 'unexpand -t 4 spaces.txt', 'unexpand --first-only spaces.txt', 'unexpand tabs.txt',
  // tee, join
  'echo hi | tee t1.tmp; cat t1.tmp', 'echo hi | tee -a t2.tmp t3.tmp; cat t2.tmp t3.tmp', 'echo x | tee', 'printf "a\\nb" | tee t4.tmp; cat t4.tmp', 'echo x | tee dir',
  'join j1.txt j2.txt', 'join -a1 j1.txt j2.txt', 'join -a2 j1.txt j2.txt', 'join -v1 j1.txt j2.txt', 'join -v2 j1.txt j2.txt', 'join -o 1.2,2.2 j1.txt j2.txt', 'join -o 0,1.2 j1.txt j2.txt', 'join -e X -a1 -o 0,2.2 j1.txt j2.txt', 'join -t, csv.txt csv.txt', 'join -1 2 -2 2 j1.txt j2.txt', 'join j1.txt nonexist.txt',
  // grep
  'grep one a.txt', 'grep -n o a.txt', 'grep -c e a.txt', 'grep -i APPLE words.txt', 'grep -v e a.txt', 'grep -w line a.txt', 'grep -x "one two" a.txt', 'grep -o "[a-z]*e" a.txt', 'grep -E "a|b" b.txt', 'grep -F "." a.txt', 'grep -l e a.txt b.txt', 'grep -L zzz a.txt', 'grep e a.txt b.txt', 'grep -h e a.txt b.txt',
  'grep -q e a.txt', 'grep -m1 e b.txt', 'grep -A1 beta b.txt', 'grep -B1 beta b.txt', 'grep -C1 gamma b.txt', 'grep -e alpha -e mu b.txt', 'grep -r kappa .', 'grep -s x nonexist.txt', 'grep zzz a.txt', 'grep -b alpha b.txt', 'grep --color=never e a.txt', 'grep -c e a.txt b.txt',
  'grep -nv a b.txt', 'grep "^t" b.txt', 'grep "a$" b.txt', 'grep -E "^(a|b)" b.txt', 'grep -E "l{2}" b.txt', 'grep "a\\|z" b.txt', 'grep -o a b.txt', 'grep -on "a" b.txt', 'grep -c "" a.txt', 'grep -i -e ALPHA -e MU b.txt', 'cat b.txt | grep -n eta', 'grep -H eta b.txt', 'grep -n -A1 -B1 gamma b.txt', 'grep -E "[0-9]+" nums.txt', 'grep -E -w "[0-9]+" nums.txt', 'grep -f c.txt d.txt', 'grep -x -f c.txt d.txt',
  // sed
  'sed s/e/E/ a.txt', 'sed s/e/E/g a.txt', 'sed -n 2p a.txt', 'sed 2d a.txt', 'sed -n "2,3p" b.txt', 'sed -n "$p" b.txt', 'sed "/beta/d" b.txt', 'sed -n "/a/p" b.txt', 'sed "s/a/&&/" b.txt', 'sed -e "s/a/A/" -e "s/e/E/" b.txt', 'sed "y/abc/xyz/" b.txt', 'sed "1!d" b.txt', 'sed "2q" b.txt',
  'sed -E "s/(a)(l)/\\2\\1/" b.txt', 'sed "s/a/b/2" b.txt', 'sed -n "/alpha/,/gamma/p" b.txt', 'sed "1~2d" b.txt', 'sed "$d" b.txt', 'sed "=" a.txt', 'sed "2i ins" b.txt', 'sed "2a app" b.txt', 'sed "2c chg" b.txt', 'sed "s/.*/\\U&/" b.txt', 'sed -n "$=" b.txt', 'sed "s/a/X/gI" words.txt', 'sed -s -n "1p" a.txt b.txt',
  'sed "2,4d" b.txt', 'sed "s|a|/|" b.txt', 'sed "s/\\(a\\)\\(l\\)/\\2\\1/" b.txt', 'sed -n "2{p;p}" b.txt', 'sed "/a/!d" b.txt', 'sed -n "l" tabs.txt', 'sed "N;s/\\n/-/" b.txt', 'sed "s/[aeiou]//g" b.txt', 'sed "5,$ s/a/A/" b.txt', 'sed -n "3,5!p" b.txt', 'sed --expression="2d" b.txt', 'sed -z "s/\\n/,/g" b.txt', 'sed "0~3d" b.txt', 'sed nonexist.txt', 'sed "s/a" b.txt'
]
