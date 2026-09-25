# News

> This file is used by the `@ecmaos-apps/news` app to update the user on the latest news.
> This is more curated than changesets - it's more for end users and critical updates.
> `install @ecmaos-apps/news` and `news` to see the latest news.

---

## 1.0.0

- ecmaOS 1.0.0 is here! Every command now runs through a real, worker-hosted `execve` -- the old in-process `ProcessManager` is gone for good.
- The shell now supports `<<` heredocs, `<<<` here-strings, `[[ ]]` tests, indexed arrays (`a=(x y)`, `${a[@]}`), `${PIPESTATUS[@]}`, and `trap`.
- Clicking a command link in terminal output now asks you to confirm before it runs.
- `/etc/passwd` and `/etc/group` moved to the real Linux format; existing installs are migrated automatically on next boot.
- Added the `free` command, and filled in a few missing `/proc` entries.
- A failed boot now leaves you with a readable error instead of a stuck spinner.
- Toolchain upgraded across the board: Vite 8, TypeScript 7, ESLint 10, vitest 5.

## 2025-12-31

- Development is picking back up!
- This project could really use some issues and PRs to move the needle forward, help out if you can!

## 2024-12-13

- Added `@ecmaos-apps/news` to pull ecmaos news
