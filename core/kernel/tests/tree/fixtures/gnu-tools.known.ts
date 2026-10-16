/**
 * Where an ecmaOS tool still differs from the real one for a command in gnu-tools.corpus.mjs. Each entry pins what ecmaOS
 * prints today and why it is accepted, so the list can only shrink: a command that starts matching, or changes what it prints,
 * fails the test until its entry is removed or updated.
 */
export interface KnownDifference {
  out: string
  code: number
  reason: string
}

export const known: Record<string, KnownDifference> = {
  "fmt -g 20 -w 30 para.txt": { out: "The quick brown fox\njumps over the lazy\ndog. Pack my box with\nfive dozen liquor\njugs. How vexingly\nquick daft zebras jump!\n\nSecond paragraph is short.\n\n   Indented third\n   paragraph that goes\n   on for a while so\n   that it has to be\n   wrapped at least\n   once or twice.\n", code: 0, reason: "GNU fmt derives its effective goal from -g in a way not reproduced" },
  "cp a.txt g.tmp; gzip -l g.tmp 2>&1 | head -n 1": { out: "gzip: g.tmp: not in gzip format\n", code: 0, reason: "compressed size or version text differs from GNU gzip (own deflate; ecmaOS version string)" },
  "gzip --version | head -n 1": { out: "gzip 1.14 (ecmaOS)\n", code: 0, reason: "compressed size or version text differs from GNU gzip (own deflate; ecmaOS version string)" },
  "gzip -c a.txt | gzip -l | cut -c1-30": { out: "         compressed        unc\n                 69           \n", code: 0, reason: "compressed size or version text differs from GNU gzip (own deflate; ecmaOS version string)" },
  "gzip -c a.txt > g.gz; gzip -l g.gz | tail -n 1 | awk \"{print \\$2, \\$3}\"": { out: "46 2.2%\n", code: 0, reason: "compressed size or version text differs from GNU gzip (own deflate; ecmaOS version string)" },
  "sed --debug \"p\" kv.txt | head -n 1": { out: "a=1\n", code: 0, reason: "sed --debug program dump is not implemented" },
  "grep -r one": { out: "a.txt:one two\ncrlf.txt:one\r\nd1.txt:one\nd2.txt:one\n", code: 0, reason: "GNU grep lists directory entries in readdir order; ecmaOS sorts them" },
  "grep -rh one . | head -n 1": { out: "one two\n", code: 0, reason: "GNU grep lists directory entries in readdir order; ecmaOS sorts them" },
  "grep -d recurse one .": { out: "./a.txt:one two\n./crlf.txt:one\r\n./d1.txt:one\n./d2.txt:one\n", code: 0, reason: "GNU grep lists directory entries in readdir order; ecmaOS sorts them" },
  "sort --version | head -n 1": { out: "sort (ecmaOS coreutils)\n", code: 0, reason: "ecmaOS version string" },
  "sort --debug nums.txt | head -n 3": { out: "-5\n10\n100\n", code: 0, reason: "sort --debug annotations are not implemented" },
  "awk 'BEGIN { print log(0), exp(1000), sqrt(-1) }' 2>&1 | cut -c1-40": { out: "awk: cmd. line:1: warning: exp: argument\nawk: cmd. line:1: warning: sqrt: called \n-inf +inf -nan\n", code: 0, reason: "awk diagnostic wording differs from gawk" },
  "awk 'BEGIN { x = 1 +\n 2; print x }' 2>&1": { out: "awk: cmd. line:1: syntax error near 'newline'\n", code: 1, reason: "awk diagnostic wording differs from gawk" },
}
