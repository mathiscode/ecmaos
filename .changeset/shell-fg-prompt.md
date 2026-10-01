---
"@ecmaos/kernel": patch
---

After `^Z`, `fg` and `^C` on the same command, the prompt is drawn once at the start of the line; the stopped command's own prompt no longer lands after the resumed one's, indented by its width. A background subshell shows as `( ... )` in `jobs` and in its Done notice.
