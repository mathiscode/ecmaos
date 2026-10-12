# cron

`man @ecmaos/kernel/commands/cron`

## Synopsis

```
cron [COMMAND] [OPTIONS]
```

## Description

Manage scheduled tasks (crontabs). Actual scheduling is done by the crond daemon (see /boot/init) - this command reads/writes crontab files and inspects cron expressions.

## Options

```
Options:
  --help  display this help and exit

Commands:
  list                    List all crontab entries (system and user)
  add <schedule> <cmd>    Add a new cron job to the user crontab
  remove <id>             Remove a cron job by ID (e.g. cron:user:2)
  edit                    Open the user crontab in an editor
  validate <expression>   Validate a cron expression
  next <expression> [N]   Show next N execution times (default: 1)
  test <expression>       Test if expression matches current time
  reload                  Informational: crond picks up file changes on its own

Examples:
  cron list                                    List all cron jobs
  cron add "*/5 * * * *" "echo hello"          Add job to run every 5 minutes
  cron remove cron:user:1                      Remove user cron job #1
  cron validate "*/5 * * * *"                  Validate cron expression
  cron next "*/5 * * * *" 5                    Show next 5 execution times
  cron test "*/5 * * * *"                      Test if expression matches now
```

## See also

`cron --help`
