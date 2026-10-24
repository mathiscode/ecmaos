# lspci

`man @ecmaos/coreutils/lspci`

## Synopsis

```
lspci [-ekmnD] [-i FILE]
```

## Description

Lists the PCI devices, from toybox 0.8.12, read from `/sys/bus/pci/devices`. A browser has no PCI bus to show (the graphics card and the network adapter are not visible as devices), so the bus is there, as it is on a Linux machine with none, and the listing is empty. Names come from a `pci.ids` file when one is found (`-i FILE`, or `/etc/pci.ids`, `/usr/share/hwdata/pci.ids`, `/usr/share/misc/pci.ids`; none is installed).

## Examples

```
lspci
lspci -nn
```

## See also

`@ecmaos/coreutils/lsusb`, `@ecmaos/coreutils/lscpu`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/lspci/`.
