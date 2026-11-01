# ifconfig

`man @ecmaos/coreutils/ifconfig`

## Synopsis

```
ifconfig [-a] [-s] [interface]
```

## Description

Shows the network interfaces. This machine has one, the loopback `lo`, so that is all there is to show; its counters stay at zero. A program reaches the network through the gateway (`gateway up`), which is not an interface, so no address is listed for it. `-s` gives the short table, `-a` is accepted. Nothing can be changed: giving an address or a flag is refused, and an interface other than `lo` is "Device not found".

## Examples

```
ifconfig
ifconfig lo
ifconfig -s
```

## See also

`@ecmaos/coreutils/ip`, `@ecmaos/kernel/commands/gateway`

## License

MIT OR Apache-2.0.
