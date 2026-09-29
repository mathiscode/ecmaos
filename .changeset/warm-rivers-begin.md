---
"@ecmaos/kernel": minor
---

## Shell startup files

`Shell.loadProfile()` runs `/etc/profile`, the first of `~/.ecmash_profile` or `~/.profile`,
`/etc/ecmashrc` and `~/.ecmashrc` through the real parser, so an alias or a function can finally
survive a login. Nothing had ever been sourced as a shell script before: `/etc/env` and `~/.env` are
`KEY=VALUE` only.

It deliberately does not go through `executeScriptText`, which would fire the `EXIT` trap the moment
the file ended, and it guards each file on its own so a broken `~/.ecmashrc` costs you a warning
rather than a shell.

### `~/.env` was read from the wrong home

The interactive login path called `loadEnvFile()` before it set `HOME` for the user who had just
authenticated, so every `~/`-rooted file resolved against the previous user's home. `~/.ecmashrc`
could not have worked until this was corrected.

### A login shell starts in `$HOME`

The cwd used to be restored from `localStorage`, which made `cd` a persistent per-user setting no
real shell has, and could never have worked in a worker, where `localStorage` does not exist.

### Also

- `parseEnvFile` dropped a bare `FOO=`, treating an empty-string assignment as a malformed line, so
  an env file could not clear an inherited variable.
- `ShellOptions.uid` and `.gid` are gone; the constructor never read either.
