# curl

`man @ecmaos/coreutils/curl`

## Synopsis

```
curl [OPTION]... URL
```

## Description

Transfer data from or to a server.

A loopback URL (`http://localhost:8000/`, `127.0.0.1`, `[::1]`) is fetched over a socket of this machine, so a server running here answers, as on Linux; there, redirects are followed only with `-L`. Any other URL goes through the browser's `fetch`, which follows redirects by itself and can only reach sites that allow cross-origin requests.

The exit status is curl's: 0 for a transfer that happened, whatever its HTTP status (22 for 400 and above with `-f`), and 7 when the connection could not be made.

## Examples

```
python3 -m http.server 8000 &
curl -sS http://localhost:8000/
curl -i http://localhost:8000/
curl -fsSL -o page.html http://localhost:8000/docs
```

## Options

```
  -o, --output=FILE        write output to FILE instead of stdout
  -O, --remote-name        write output to a file named like the remote file
  -X, --request=METHOD     HTTP method to use (default: GET)
  -d, --data=DATA          send data in POST request
  -H, --header=HEADER      add custom HTTP header (format: "Name: Value")
  -i, --include            include the response's status line and headers in the output
  -I, --head               fetch the headers only (HEAD)
  -L, --location           follow redirects
  -f, --fail               fail silently (exit 22) on an HTTP error
  -s, --silent             silent mode (don't show progress or errors)
  -S, --show-error         with -s, still show errors
  -v, --verbose            verbose mode (show request/response headers)
  --help                   display this help and exit
```
