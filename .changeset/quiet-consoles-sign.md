---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

## Who is logged in

- `/run/utmp` holds one line per console with a login, emptied each boot. `/var/log/wtmp` records
  every login and every boot. Both are tab-separated text; nothing else reads them. `su` counts as a
  login on its console.
- `who` lists the consoles (`-b` for the boot time, `-q` for a count). `last [-n NUM] [USER]` lists
  past logins newest first. There is no logout record, since a console session ends when the page
  does, so `last` ends a session at the next boot.
