# printf

`man @ecmaos/kernel/commands/printf`

## Synopsis

```
printf FORMAT [ARGUMENT]...
```

## Description

Format and print ARGUMENT(s) according to FORMAT.

## Options

```
FORMAT controls the output as in C printf.  Interpreted sequences:

  \\     backslash
  \a      alert (BEL)
  \b      backspace
  \c      produce no further output
  \e      escape
  \f      form feed
  \n      new line
  \r      carriage return
  \t      horizontal tab
  \v      vertical tab
  \0NNN   byte with octal value NNN (1 to 3 digits)
  \xHH    byte with hexadecimal value HH (1 to 2 digits)

Conversion specifiers:

  %b      ARGUMENT as a string with '\' escapes interpreted
  %c      ARGUMENT as a single character
  %d      ARGUMENT as a signed decimal integer
  %i      ARGUMENT as a signed decimal integer
  %o      ARGUMENT as an unsigned octal number
  %s      ARGUMENT as a string
  %u      ARGUMENT as an unsigned decimal integer
  %x      ARGUMENT as an unsigned hexadecimal number (lowercase)
  %X      ARGUMENT as an unsigned hexadecimal number (uppercase)
  %%      a single %

  --help  display this help and exit
```

## See also

`printf --help`
