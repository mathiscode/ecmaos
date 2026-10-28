# cowsay

`man @ecmaos/coreutils/cowsay`

## Synopsis

```
cowsay [-bdgpstwy] [-e EYES] [-T TONGUE] [-f COWFILE] [-n] [-W COLUMN] [MESSAGE]
cowthink [same options] [MESSAGE]
cowsay -l
```

## Description

A cow saying `MESSAGE` (or standard input) in a balloon; `cowthink` draws a thought bubble instead. The message is wrapped at 40 columns (`-W` sets another, `-n` keeps its lines as they are, for figlet or a table).

`-e` and `-T` give the eyes and the tongue, two characters each. The modes set both: `-b` borg, `-d` dead, `-g` greedy, `-p` paranoid, `-s` stoned, `-t` tired, `-w` wired, `-y` youthful.

`-f` draws another creature: a name on `COWPATH` (`/usr/share/cows` by default; `-l` lists them) or a path to a `.cow` file. Cow files are cowsay's own format, a Perl heredoc assigned to `$the_cow` in which `$eyes`, `$tongue` and `$thoughts` are filled in, so the cows of other collections can be copied into `/usr/share/cows` and used as they are. Any other Perl in a cow file is not run.

## Examples

```
cowsay Hello
fortune | cowsay -f owl
cowthink -d "is it Friday yet"
figlet moo | cowsay -n
```

## See also

`fortune`, `figlet`, `lolcat`
