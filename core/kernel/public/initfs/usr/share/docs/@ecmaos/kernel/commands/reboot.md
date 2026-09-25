# reboot

`man @ecmaos/kernel/commands/reboot`

## Synopsis

```
reboot
```

## Description

Shuts down every kernel subsystem cleanly, then reloads the page. `kernel.reboot()` is a main-thread-only method (it ultimately calls `globalThis.location.reload()`, which doesn't exist inside a Web Worker), so this reaches it through the `reboot` main-thread custom syscall, the same pattern `window_create` uses for other main-thread-only DOM/kernel capabilities.

## See also

`@ecmaos/kernel/commands/ps`
