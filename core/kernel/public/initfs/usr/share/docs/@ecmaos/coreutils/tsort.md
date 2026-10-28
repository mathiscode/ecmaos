# tsort

`man @ecmaos/coreutils/tsort`

## Synopsis

```
tsort [FILE]
```

## Description

Read pairs of items (`A B` means A comes before B) and write the items in an order that keeps every pair. A loop is reported, its members are named on standard error, and it is broken so that every item is still written; the status is then 1.

## See also

`sort`
