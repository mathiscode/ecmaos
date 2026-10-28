# at

`man @ecmaos/coreutils/at`

## Synopsis

```
at [-q QUEUE] [-f FILE] [-Mv] TIME
at -t [[CC]YY]MMDDhhmm[.ss]
at -c JOB...
atq [-q QUEUE]
atrm JOB...
batch
```

## Description

Queue commands to run once, at a later time. The commands come from standard input, or from `-f FILE`, and run in `/bin/sh` as you. They start in the directory you queued them from, with your environment and umask.

The time is one of these, optionally followed by `+ N minutes`, `hours`, `days`, `weeks`, `months` or `years`:

- `now`
- a time of day: `HH:MM`, `HHMM`, `3pm`, `noon`, `midnight` or `teatime` (4pm), optionally followed by a date

A date is `today`, `tomorrow`, a weekday, `MONTH DAY [YEAR]`, `MM/DD/YY`, `DD.MM.YY` or `YYYY-MM-DD`. A time of day already past today, given with no date, means tomorrow.

`atq` lists your jobs (root sees everyone's) as `JOB DATE QUEUE USER`. `at -c` prints a job's script, and `atrm` (or `at -r`) removes jobs. `batch` queues a job to run now: there is no load average to wait for.

Each job is a script in `/var/spool/cron/atjobs`. `crond` checks the queue every few seconds and runs a job that is due as its owner, then removes it. There is no mail to send a job's output by, so it goes to the system log under the tag `at` (`journalctl -t at`). `-m` is refused, and `-M` is accepted.

`at` runs with the setuid bit so the spool can be root's. `/etc/at.allow` and `/etc/at.deny` decide who may use it, the same way crontab's files do.

## Options

```
  -f FILE   read the commands from FILE
  -q QUEUE  the queue, a letter (a by default; b for batch)
  -t TIME   the time as touch(1) takes it
  -v        show the time the job will run
  -l        as atq
  -r, -d    as atrm
  -c        print the jobs given
  -M        send no mail (none is ever sent)
```

## See also

`crontab`, `crond`, `journalctl`
