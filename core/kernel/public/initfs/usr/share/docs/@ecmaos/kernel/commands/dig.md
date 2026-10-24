# dig

`man @ecmaos/kernel/commands/dig`

## Synopsis

```
dig [+short] NAME [A | AAAA]
```

## Description

Looks up the addresses of a name, in `/etc/hosts` and then by the gateway's resolver (`gateway up`), and prints the answer the way `dig` does; `+short` prints only the addresses. Only `A` and `AAAA` records exist. The time to live is 0 because the resolver does not pass it on, the server is "the gateway", and there is no `@server` or reverse lookup.

Exit status is 0 on an answer, 1 for an unsupported request, and 9 when no resolver could be reached.

## Examples

```
dig example.com
dig +short example.com AAAA
```

## See also

`@ecmaos/kernel/commands/host`, `@ecmaos/kernel/commands/nslookup`, `@ecmaos/kernel/commands/gateway`
