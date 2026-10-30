# npm

`man @ecmaos/kernel/commands/npm`

## Synopsis

```
npm install [PACKAGE...]    npm ci    npm uninstall PACKAGE...    npm update [PACKAGE...]
npm ls    npm outdated    npm run [SCRIPT] [-- ARGS...]    npm test | start | stop | restart
npm exec PACKAGE [ARGS...]    npx [-y] [-p PACKAGE] COMMAND [ARGS...]
npm init [-y]    npm view PACKAGE [FIELD]    npm search TEXT    npm config get registry
npm cache clean --force    npm root | prefix | bin [-g]
```

## Description

npm's commands over [`install`](install.md)'s engine. In a project (the nearest directory with a `package.json` or `node_modules`) `npm install PACKAGE` puts the package in `node_modules`, links it at `node_modules/NAME`, links its bins in `node_modules/.bin`, and records `"NAME": "^VERSION"` in `package.json` (`-D` in `devDependencies`, `-O` in `optionalDependencies`, `-E` exact, `--no-save` not at all). Dependencies live in `node_modules/.ecmaos/NAME/VERSION`, each with a `node_modules` of its own, as pnpm lays them out; `/bin/node` resolves them as Node does. `npm install` with no names installs what `package.json` lists and removes what it no longer lists; `npm ci` starts from an empty `node_modules`. There is no lockfile.

`-g` installs where `install` does: `/usr` as root, `~/.local` for anyone else.

`npm run` runs a script with `sh -c`, `node_modules/.bin` first on `PATH`, running `pre` and `post` scripts around it and giving it `npm_lifecycle_event`, `npm_package_name` and `npm_package_version`; arguments after `--` are appended. `npx` and `npm exec` run a command from `node_modules/.bin` when there is one, else fetch the package into the cache (asking `Ok to proceed?` unless `-y`) and run its bin. Dependencies' own install scripts do not run (see `install --allow-scripts`).

`npm outdated` exits 1 when something is outdated. `npm update` moves packages up within the ranges `package.json` allows (and to the latest with `-g`).

Commands that need an npm account (`publish`, `login`, `whoami`, `audit`...) say they are not available. `npm config set` is not supported: use `--registry` or `$REGISTRY`.

## See also

[`yarn`](yarn.md), [`pnpm`](pnpm.md), [`install`](install.md), [`node`](node.md)
