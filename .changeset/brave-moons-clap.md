---
"@ecmaos/kernel": minor
---

## Brace expansion

`{a,b}`, `{1..10}`, `{a..e}`, nested, and any number of them in one word. `mkdir -p src/{lib,bin}`
made a single directory literally named `src/{lib,bin}` before this.

It is the shell's first expansion and the only purely textual one: `{a,b}` becomes two words whether
or not anything by those names exists, which is what separates it from globbing and what makes
`mkdir` the everyday case. It runs on every path that turns a word into fields, so a command's
arguments, a `for` list and an array literal all behave the same.

Three rules keep it from eating ordinary text:

- **Quoting suppresses it.** `"{a,b}"` stays one word, so the pass works on a word's parts rather
  than flat text: only characters from unquoted runs can open, close or separate a brace expression.
- **`${` is never an opener.** A parameter expansion can legitimately hold braces and commas, so
  `${x:-a,b}` is left alone. Expansion spans are skipped whole using the same scanner the tokenizer
  uses, rather than a second guess at where one ends.
- **A brace with no top-level comma and no valid sequence is literal.** `echo {}`, `echo {foo}`,
  `echo {1..x}` and an unmatched `{` all print themselves, as in every real shell.

Sequences support a step (`{1..9..3}`), descending ranges, negative endpoints, and zero padding
(`{08..11}` gives `08 09 10 11`), with the same refusal bash has for an unbounded one.
