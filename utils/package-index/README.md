# @ecmaos/package-index

The names `apt`, `pacman` and the other front-ends of `install` know packages by, mapped to the npm packages that
provide them. `apt update` and `pacman -Sy` fetch the latest version of this package and keep its `index.json`.

`index.json`:

- `common`: the names every front-end knows. A key is a name a user types; a value is `{ "package": NPM_NAME,
  "description": TEXT }` (optionally `"range"`), or `{ "provided": TEXT }` when ecmaOS already ships it.
- `apt`, `pacman`: names only that front-end knows. A value is a string naming an entry of `common`, or an entry of
  its own.

A name no entry matches is not installed by guesswork: the front-end says it cannot find the package and searches npm
for something close.
