# web

`man @ecmaos/kernel/commands/web`

## Synopsis

```
web [OPTIONS] [URL]
```

## Description

Open a URL in a new contained window. Many sites will block the COR, so this is mostly useful for local/bespoke/credentialless resources. To open in a new tab/browser window, use the 'open' command instead.

## Options

```
  --help                               display this help and exit
  --no-navbar                          hide the navigation bar

Examples:
  web https://example.com              open a URL in a browser window
  web --no-navbar https://example.com  open a URL without navigation bar
  web example.com                      open a URL (https:// will be prepended)
  web http://example.com               open a URL with http protocol
```

## See also

`web --help`
