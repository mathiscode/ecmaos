# tr

`man @ecmaos/coreutils/tr`

## Synopsis

```
tr [OPTION]... SET1 [SET2]
```

## Description

Translate, squeeze, and/or delete characters from standard input, writing to standard output.

Works on bytes. A set may use ranges, classes (`[:alpha:]`), equivalence classes (`[=a=]`), repeats (`[c*3]`) and escapes (`\n`, `\NNN`). With `-s` after `-d`, the squeeze set is the second set.

## Options

```
  -c, -C, --complement    use the complement of SET1
  -d, --delete            delete characters in SET1, do not translate
  -s, --squeeze-repeats   replace each sequence of a repeated character that is listed in the last specified SET, with a single occurrence of that character
  -t, --truncate-set1     first truncate SET1 to length of SET2
  --help                  display this help and exit

SETs are specified as strings of characters. Interpreted sequences are:
  \NNN            character with octal value NNN (1 to 3 octal digits)
  \\              backslash
  \a \b \f \n \r \t \v   the usual escapes
  CHAR1-CHAR2     all characters from CHAR1 to CHAR2 in ascending order
  [CHAR*]         in SET2, copies of CHAR until length of SET1
  [CHAR*REPEAT]   REPEAT copies of CHAR, REPEAT octal if starting with 0
  [:alnum:] [:alpha:] [:blank:] [:cntrl:] [:digit:] [:graph:] [:lower:] [:print:] [:punct:] [:space:] [:upper:] [:xdigit:]
  [=CHAR=]        all characters which are equivalent to CHAR
```
