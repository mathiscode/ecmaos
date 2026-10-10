# xclip

`man @ecmaos/kernel/commands/xclip`

## Synopsis

```
xclip [-i|-o] [FILE...]
pbcopy
pbpaste
```

## Description

Copy to, and paste from, the browser clipboard. With no option `xclip` copies standard input (or the files); `-o` prints the clipboard. `pbcopy` and `pbpaste` are links to the same program, for scripts written on macOS: `pbcopy` copies, `pbpaste` prints.

The browser has one clipboard, so `-selection` is accepted and ignored. Reading may make the browser ask the user for permission, and some browsers only allow it while the page has focus; a refusal is reported and the exit status is 1.

## Options

```
  -i, -in         copy to the clipboard (the default)
  -o, -out        print the clipboard to standard output
  -selection NAME accepted and ignored
  -r, -rmlastnl   accepted and ignored
  --help          display this help and exit
```

## Example

```
git log --oneline | head -5 | xclip
xclip -o > pasted.txt
```

## See also

`notify-send`, `open`
