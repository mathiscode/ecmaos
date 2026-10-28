# fortune

`man @ecmaos/coreutils/fortune`

## Synopsis

```
fortune [-acefilsw] [-n LENGTH] [-m PATTERN] [[N%] FILE|DIR ...]
```

## Description

fortune from fortune-mod 3.24.0: a random epigram from the cookie files in `/usr/share/games/fortunes` (computers, linux, science, wisdom, tao, zippy and more; `fortune -f` lists them with their share of the choice). Name files or directories to choose among only those, each with a percentage if wanted (`fortune 50% linux computers`). `-s` and `-l` pick only short or long ones (`-n` sets the length), `-m` prints every cookie matching a regular expression, `-c` names the file a cookie came from, `-e` gives every file an equal chance, and `-w` waits after a long one so it can be read.

A file of your own is a text file with cookies separated by lines holding only `%`, and its index made by strfile (`NAME.dat`); fortune also looks in `/usr/local/share/games/fortunes`. fortune-mod's offensive cookies are not installed, so `-o` and `-a` find none of them.

## Examples

```
fortune
fortune -s linux
fortune | cowsay
fortune -m 'Unix'
```

## License

BSD-4-Clause-UC (Berkeley's license; the University withdrew its advertising clause in 1999), the cookies too. The license text is in `/usr/share/licenses/@ecmaos/coreutils/fortune/`.

## See also

`cowsay`
