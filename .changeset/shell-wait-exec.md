---
"@ecmaos/kernel": patch
---

A bare `wait` in the kernel shell waits for background jobs only. Under `exec > file` it ran as its own foreground job and waited on itself, so `sleep 1 & wait` hung.
