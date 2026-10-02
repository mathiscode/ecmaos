# app

`man @ecmaos/kernel/commands/app`

## Synopsis

```
app <program> [args...]
```

## Description

Run an `@ecmaos-apps/*` program. A program with the `#!ecmaos:bin:program:<name>` shebang runs directly in the worker. One with `#!ecmaos:bin:app:<name>` needs the DOM, so it runs through the app presenter instead. Either way, the value the app returns becomes the exit status of `app`.

You rarely type this yourself: running an app by name goes through it.

## Exit status

The app's return value, 2 when no program is given, and 1 when the program cannot be read or run (the reason is printed on standard error).

## See also

`@ecmaos/kernel/commands/install`, `@ecmaos/kernel/commands/uninstall`
