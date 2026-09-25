# df

`man @ecmaos/kernel/commands/df`

## Synopsis

```
df
```

## Description

Reports storage usage as the browser's Storage API sees it (`navigator.storage.estimate()`), formatted to human-readable sizes. `kernel.storage.usage()` is a live main-thread `Kernel` method with no worker-side equivalent, so this reaches it through the `storage_usage` main-thread custom syscall, which hands back the raw `StorageEstimate` as JSON for the coreutil-side process to format.

## Notes

This reports browser-level storage quota/usage, not per-filesystem-backend disk usage the way Linux `df` reports per-mount block usage -- ecmaOS has multiple mountable filesystem backends (IndexedDB, OPFS, memory, WebStorage, and more), and this command does not yet break usage down per mount.

## See also

`@ecmaos/coreutils/free`, `@ecmaos/kernel/commands/ps`
