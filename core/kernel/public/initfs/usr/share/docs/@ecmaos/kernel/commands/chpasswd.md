# chpasswd

`man @ecmaos/kernel/commands/chpasswd`

## Synopsis

```
chpasswd
```

## Description

Set many passwords at once from lines of `USER:PASSWORD` on standard input. Root only. The passwords are hashed here, so `-e` (already hashed) is refused. A password may not contain `:` or a line break.

## Options

```
  --help   display this help and exit
```

## Example

```
printf 'alice:s3cret!\nbob:other-pass\n' | chpasswd
```
