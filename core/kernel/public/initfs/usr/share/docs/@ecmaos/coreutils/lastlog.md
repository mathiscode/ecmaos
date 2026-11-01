# lastlog

`man @ecmaos/coreutils/lastlog`

## Synopsis

```
lastlog [-u login] [-t days] [-b days]
```

## Description

Lists every account in `/etc/passwd` with its latest login, built from `/var/log/wtmp`: the port and the time, or `**Never logged in**`. `-u` shows one account, `-t DAYS` only logins within that many days and `-b DAYS` only those older. `-C` and `-S` would change the records and are refused. There is no remote host to show, so `From` stays empty.

## Examples

```
lastlog
lastlog -u root
lastlog -t 7
```

## See also

`@ecmaos/coreutils/last`, `@ecmaos/coreutils/who`

## License

MIT OR Apache-2.0.
