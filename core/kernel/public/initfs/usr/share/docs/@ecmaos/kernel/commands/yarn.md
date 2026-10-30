# yarn

`man @ecmaos/kernel/commands/yarn`

## Synopsis

```
yarn [install]    yarn add [-D] PACKAGE...    yarn remove PACKAGE...    yarn upgrade [PACKAGE...]
yarn list    yarn outdated    yarn run SCRIPT    yarn SCRIPT    yarn init -y    yarn info PACKAGE
yarn dlx PACKAGE [ARGS...]    yarn global add|remove|list PACKAGE...
```

## Description

Yarn's commands over [`install`](install.md)'s engine, with yarn classic's output (`[1/4] Resolving packages...`, `success Saved 1 new dependency.`, `Done in 0.42s.`). The project layout, `package.json` handling and scripts are those of [`npm`](npm.md); a name that is not a command is a script (`yarn build`), and what follows it goes to the script. There is no lockfile. `yarn global` installs where `install -g` does.

## See also

[`npm`](npm.md), [`pnpm`](pnpm.md)
