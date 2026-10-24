# nslookup

`man @ecmaos/kernel/commands/nslookup`

## Synopsis

```
nslookup NAME
```

## Description

Looks up the addresses of a name, in `/etc/hosts` and then by the gateway's resolver (`gateway up`), and prints them as `nslookup` does. The server is "the gateway": a name is resolved on the host machine, so there is no nameserver address. There is no interactive mode, no other record type and no reverse lookup.

## Examples

```
nslookup example.com
```

## See also

`@ecmaos/kernel/commands/host`, `@ecmaos/kernel/commands/dig`, `@ecmaos/kernel/commands/gateway`
