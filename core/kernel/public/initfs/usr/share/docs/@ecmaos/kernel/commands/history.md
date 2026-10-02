# history

`man @ecmaos/kernel/commands/history`

## Synopsis

```
history [OPTION]... [N]
```

## Description

Display or manipulate the command history.

## Options

```
  N              display the last N entries
  -c             clear the history list
  -d N           delete the history entry at position N
  -r             reload the history file (useful after manual edits)
  --help         display this help and exit

If N is provided without options, display the last N entries.
If no arguments are provided, display all history entries.

Note: History is automatically saved on each command execution.
```

## See also

`history --help`
