# fetch

`man @ecmaos/kernel/commands/fetch`

## Synopsis

```
fetch [OPTION]... URL
```

## Description

Fetch a resource from the network.

## Options

```
  -o, --output=FILE        write output to FILE instead of stdout
  -X, --method=METHOD      HTTP method to use (default: GET)
  -d, --data=DATA          request body data to send
  -H, --header=HEADER      add custom HTTP header (format: "Name: Value")
  --help                   display this help and exit

Examples:
  fetch https://example.com              fetch and output to stdout
  fetch -o file.txt https://example.com  fetch and save to file.txt
  fetch -X POST -d "data" https://api.example.com  POST request with body
```

## See also

`fetch --help`
