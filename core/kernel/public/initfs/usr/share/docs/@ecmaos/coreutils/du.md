# du

`man @ecmaos/coreutils/du`

## Synopsis

```
du [OPTION]... [FILE]...
```

## Description

Shows the size of each FILE and of every directory in it, recursively, the current directory by default. Sizes are the sizes of the files themselves, in KiB rounded up (there are no disk blocks to count here), and a directory counts only what is in it. Symbolic links are not followed.

## Options

- `-a, --all`: show a size for files too
- `-b, --bytes`: sizes in bytes
- `-k`: sizes in KiB (the default)
- `-h, --human-readable`: sizes as 1K, 234M, 2G
- `-s, --summarize`: only a total for each argument
- `-c, --total`: also a grand total
- `-d, --max-depth=N`: show only directories N levels down or fewer

## Exit status

0, or 1 when something could not be read.

## See also

`@ecmaos/kernel/commands/df`, `@ecmaos/coreutils/ls`
