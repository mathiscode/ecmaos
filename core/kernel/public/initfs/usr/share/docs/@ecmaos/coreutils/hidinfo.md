# hidinfo

`man @ecmaos/coreutils/hidinfo`

## Synopsis

```
hidinfo [-d] [-f REPORT_ID] [DEVICE...]
```

## Description

Lists the HID devices behind `/dev/hidraw<n>` (those `hid request` has been given in the browser), or the ones named, and for each prints what the hidraw ioctls say of it: its name (`HIDIOCGRAWNAME`), bus, vendor and product ids (`HIDIOCGRAWINFO`), its physical name (`HIDIOCGRAWPHYS`) and the size of its report descriptor (`HIDIOCGRDESCSIZE`).

`-d` also prints the report descriptor (`HIDIOCGRDESC`) in hex. `-f` reads a feature report by id (`HIDIOCGFEATURE`); the bytes begin with the id.

A browser does not show a device's own report descriptor, only the collections it parsed from it, so the descriptor here is written from those: the same reports and fields, but not the bytes the device sent. The bus is always USB, and the physical name is made from the ids.

## Examples

```
hidinfo
hidinfo -d /dev/hidraw0
hidinfo -f 5 /dev/hidraw0
```

## License

MIT OR Apache-2.0.
