# pnpm

`man @ecmaos/kernel/commands/pnpm`

## Synopsis

```
pnpm install    pnpm add [-D] [-g] PACKAGE...    pnpm remove PACKAGE...    pnpm update [PACKAGE...]
pnpm list    pnpm outdated    pnpm run SCRIPT    pnpm test | start    pnpm exec COMMAND    pnpm dlx PACKAGE
pnpm init    pnpm view PACKAGE    pnpm search TEXT    pnpm root
```

## Description

pnpm's commands over [`install`](install.md)'s engine, with pnpm's output (`Packages: +3`, `Progress: resolved 3, reused 0, downloaded 3, added 3, done`, `dependencies: + NAME VERSION`, `Done in 1s`). The `node_modules` layout is pnpm's own idea, which `install` already uses: packages in `node_modules/.ecmaos` linked from `node_modules`. Project handling, scripts and `-g` are those of [`npm`](npm.md). There is no lockfile.

## See also

[`npm`](npm.md), [`yarn`](yarn.md)
