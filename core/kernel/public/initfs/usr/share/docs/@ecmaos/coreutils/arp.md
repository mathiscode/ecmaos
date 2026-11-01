# arp

`man @ecmaos/coreutils/arp`

## Synopsis

```
arp [-an] [hostname]
```

## Description

Shows the ARP cache, which is always empty: no interface here speaks ARP. A host name gives "no entry" and exit status 255. `-s` and `-d` are refused.

## Examples

```
arp -a
```

## See also

`@ecmaos/coreutils/ip`, `@ecmaos/coreutils/ifconfig`

## License

MIT OR Apache-2.0.
