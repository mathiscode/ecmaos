# localectl

`man @ecmaos/coreutils/localectl`

## Synopsis

```
localectl [status]
localectl set-locale [LANG=]LOCALE [LC_*=LOCALE...]
localectl list-locales
```

## Description

Show and set the system locale, `LANG` and any `LC_*` setting in `/etc/default/locale`. Boot reads the file: the kernel's own messages change language at the next boot, and programs see the new `LANG` in a new login's environment.

The locales there are `C.UTF-8` and one for each language the kernel has translations for, which it lists in `/usr/share/i18n/SUPPORTED`. A locale not among them is refused. Setting is root's.

The keyboard layout is the host's, so `set-keymap`, `set-x11-keymap` and the keymap lists are refused.

## See also

`locale`, `/etc/default/locale`
