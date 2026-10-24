# host

`man @ecmaos/kernel/commands/host`

## Synopsis

```
host [-4] [-6] [-t A|AAAA] NAME
```

## Description

Looks up the addresses of a name. The name is looked up in `/etc/hosts` first, then by the gateway's resolver (`gateway up`); without a gateway, only `/etc/hosts` answers and any other name says no servers could be reached. `-4` and `-6` choose a family, and `-t` an `A` or `AAAA` record. Other record types and reverse lookups are not available, since the resolver gives addresses and nothing else.

## Examples

```
host localhost
host -4 example.com
```

## See also

`@ecmaos/kernel/commands/dig`, `@ecmaos/kernel/commands/nslookup`, `@ecmaos/kernel/commands/gateway`
