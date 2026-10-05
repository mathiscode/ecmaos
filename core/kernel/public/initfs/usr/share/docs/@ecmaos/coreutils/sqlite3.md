# sqlite3

`man @ecmaos/coreutils/sqlite3`

## Synopsis

```
sqlite3 [OPTIONS] [DATABASE] [SQL]...
```

## Description

The SQLite 3.53 command-line shell, built to WebAssembly and run as an ordinary program. With no `DATABASE`
(or `:memory:`) it works on a database in memory. Give SQL on the command line, pipe it in, or run it
interactively: the prompt reads a line at a time from the terminal, which edits the line itself (there is
no readline history).

Compiled in: JSON functions, FTS5 full-text search, the math functions (`sqrt`, `pi`, `round`, ...), the
`dbstat` virtual table and column metadata. Dot-commands (`.tables`, `.schema`, `.mode`, `.import`, `.dump`,
`.read`, `.headers on`, ...) work as in the original.

Not available: loadable extensions (`.load`), threads, memory-mapped I/O, and locking between programs: a
lock is always granted, so two programs writing the same database file at the same moment are not kept apart.

## Options

The shell's own: `-header`, `-column`, `-csv`, `-json`, `-separator SEP`, `-cmd COMMAND`, `-readonly`, `-bail`,
`-init FILE`, `-batch`, `-version`, and the rest of `sqlite3 -help`.

## Examples

```
sqlite3 :memory: "select 6*7"
sqlite3 notes.db "create table t(id integer primary key, body text); insert into t(body) values ('hi')"
sqlite3 -header -column notes.db "select * from t"
echo "select json_extract('{\"a\":[1,2]}', '$.a[1]');" | sqlite3
sqlite3 notes.db .dump > notes.sql
```

## License

SQLite 3.53.4 (public domain) with linenoise (BSD-2-Clause). The license text is in `/usr/share/licenses/@ecmaos/coreutils/sqlite3/`.
