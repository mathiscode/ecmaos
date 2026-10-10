# say

`man @ecmaos/kernel/commands/say`

## Synopsis

```
say [-v VOICE] [-r RATE] [-p PITCH] [-l LANG] [-f FILE] [TEXT...]
```

## Description

Speak text aloud with the browser's speech synthesis. The text is the arguments, the file named by `-f` (`-` for standard input), or standard input when there are none. `say` returns when the speech ends; `^C` stops it. The voices are the ones the browser and the operating system offer, so they differ between machines: `say -v ?` lists them.

## Options

```
  -v, --voice=NAME   the voice to use; '-v ?' lists them
  -r, --rate=N       speed, as a multiple of normal (1 is normal)
  -p, --pitch=N      pitch, from 0 to 2 (1 is normal)
  -l, --lang=TAG     a language tag such as en-GB
  -f, --input-file=F read the text from a file
  --help             display this help and exit
```

## See also

`notify-send`, `play`
