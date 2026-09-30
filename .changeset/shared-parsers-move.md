---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": patch
---

## The shell's parsing and line-editing code lives in `@ecmaos/coreutils`

`shell-parser`, `expand-variables`, `control-flow-parser`, `word-expansion`, `conditional-eval`,
`brace-expansion`, `line-editor`, `history` and `completion` moved from the kernel to
`@ecmaos/coreutils/lib/<name>`, with their tests (196, now run by `pnpm test` in `core/utils`). They
import nothing from the kernel, so a worker-hosted shell can bundle them. No behavior change.
