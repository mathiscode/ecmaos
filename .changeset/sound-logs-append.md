---
"@ecmaos/kernel": patch
---

## Appending to a file corrupted it

`appendFile` on the root filesystem writes each new chunk at offset 0 of the file it has just grown,
so a second append overwrote the first record and left NUL bytes for the rest. This was reproduced in
the browser, not just in tests. Everything that appended was affected:

- `echo a >> f; echo b >> f` produced `b` and NULs. A `>` whose output arrived in several chunks did
  the same. Redirection now collects the output and rewrites the target whole, throttled to every
  250ms while output flows and always on close.
- `~/.history` was corrupted after the second command. History is written from a cached copy, and a
  file already damaged is healed on load by dropping the NUL bytes.
- `/etc/shadow` (a second `useradd`) and `/var/log/kernel.log` had the same fault.

A handle write at a nonzero offset lands at 0 as well, which is why the fix rewrites rather than seeks.
Worth reporting upstream to `@zenfs/core`.
