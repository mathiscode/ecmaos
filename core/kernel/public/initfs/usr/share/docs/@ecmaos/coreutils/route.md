# route

`man @ecmaos/coreutils/route`

## Synopsis

```
route [-n] [-A family]
```

## Description

Shows the routing table, which is empty: the gateway carries a program's connections and is not a route. `-A inet6` prints the IPv6 header. `add`, `del` and `flush` are refused, since nothing can be changed.

## Examples

```
route
route -n
```

## See also

`@ecmaos/coreutils/ip`, `@ecmaos/coreutils/ifconfig`

## License

MIT OR Apache-2.0.
