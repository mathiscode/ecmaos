---
"@ecmaos/kernel": minor
---

The kernel shell now prefixes its own diagnostics the way `ecmash` does: `ecmaos: cd: /x: no such file or directory`, `ecmaos: foo: command not found` (was `Command not found: foo`, translated in en, es and de). A command's own errors are unchanged.
