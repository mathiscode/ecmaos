# ip

`man @ecmaos/coreutils/ip`

## Synopsis

```
ip [-4] [-6] [-br] addr | link | route | neigh [show [dev lo]]
```

## Description

Shows the machine's network interfaces. There is one, the loopback `lo`, with `127.0.0.1/8` and `::1/128`. A program reaches the network through the gateway (`gateway up`), which is not an interface: it carries each connection a program opens, so there is no address or route to show for it. `ip route` and `ip neigh` print nothing for that reason.

`-4` and `-6` choose a family and `-br` prints one line for each interface. Nothing can be changed: `ip addr add`, `ip link set` and the like are refused, and so is a device other than `lo`.

## Examples

```
ip addr
ip -br addr
ip link
```

## See also

`@ecmaos/coreutils/ss`, `@ecmaos/coreutils/netstat`, `@ecmaos/kernel/commands/gateway`
