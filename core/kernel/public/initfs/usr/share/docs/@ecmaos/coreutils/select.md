# select

`man @ecmaos/coreutils/select`

## Synopsis

```
select NAME [in WORDS ...;] do COMMANDS; done
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. A loop, not a command: it prints WORDS as a numbered menu on standard error, prompts with `$PS3` (default `#? `), and reads a line from standard input into `REPLY`. A number in range sets NAME to that word; anything else sets it to the empty string. COMMANDS then run, and the loop asks again. An empty reply prints the menu again without running anything; end of input ends the loop with status 1; `break` ends it too.

Without `in WORDS` the menu is the positional parameters. The menu is laid out in columns that fit `$COLUMNS` (80 when unset), the way bash lays it out. A redirection on the loop (`done < file`) supplies the replies.

## Examples

```
PS3="color? "
select c in red green blue; do
  echo "you chose $c"
  break
done
```

## Exit status

The status of the last command run in COMMANDS, or 1 when input ended.

## See also

`read`, `@ecmaos/coreutils/ecmash`
