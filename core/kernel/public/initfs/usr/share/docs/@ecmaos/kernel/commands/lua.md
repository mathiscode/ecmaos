# lua

`man @ecmaos/kernel/commands/lua`

## Synopsis

```
lua [OPTIONS] [SCRIPT [ARGS]...]
```

## Description

Lua 5.4, the scripting language, built to WebAssembly and run as an ordinary program. With no script it starts
the interactive interpreter on the terminal; with a script it runs the file, with `ARGS` in the `arg` table;
`-` reads the script from standard input.

The whole standard library is there: `string` (with Lua patterns), `table`, `math`, `utf8`, `coroutine`, `os`
(`time`, `date`, `clock`, `getenv`, `remove`, `rename`, and `execute`, which runs the command with `/bin/ecmash -c`) and `io` (files, `io.lines`, `io.read` from standard input).
`require` loads Lua modules from `LUA_PATH`; C modules cannot be loaded (no `dlopen`), and `io.popen` is not supported (it returns nil).

## Options

`-e CHUNK` run a string, `-l NAME` require a library first, `-i` enter the interpreter after the script, `-v`
print the version, `-E` ignore `LUA_INIT` and `LUA_PATH`, `-W` turn on warnings, `--` stop handling options.

Exit status: 0 on success, 1 when the script or chunk fails (the error and a stack traceback go to standard error).

## Examples

```
lua -e 'print(2^10)'
lua script.lua one two
echo 21 | lua -e 'print(io.read("n") * 2)'
```
