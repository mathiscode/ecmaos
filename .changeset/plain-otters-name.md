---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## `ShellConfig` is `TerminalConfig`, and `shell.toml` is `terminal.toml`

Every key in that file is an xterm.js terminal property: font, cursor, theme, renderer,
scroll duration. Nothing in it is a shell setting, so the name pointed at the wrong layer, and now
that the shell has real startup files the distinction matters to anyone editing either.

- `ShellConfig` and `ShellConfigManager` are `TerminalConfig` and `TerminalConfigManager`, and they
  live in `@ecmaos/types`' `terminal.ts` rather than `shell.ts`.
- `/etc/shell.toml` and `~/.config/shell.toml` are `/etc/terminal.toml` and
  `~/.config/terminal.toml`.
- **Migration 3** renames both on a persisted root, for every home in `/etc/passwd`. No `shell.toml`
  ships in initfs, but `theme <name>` writes one, so an existing filesystem would otherwise lose its
  theme. A `terminal.toml` already in place wins and the old file is removed rather than merged.
