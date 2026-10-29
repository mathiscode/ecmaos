# wget

`man @ecmaos/coreutils/wget`

## Synopsis

```
wget [OPTION]... URL...
```

## Description

Download files over HTTP and HTTPS, using `fetch`, as GNU wget does for the common cases.

**Where a file goes.** A file is named after the last part of its URL, and a URL ending in `/` is saved as `index.html`. When that name is already taken, the new file is numbered (`file.1`, `file.2`). The options that change this:

- `-O FILE` writes everything to FILE, and `-O -` writes it to standard output.
- `-P DIR` saves under DIR.
- `-nc` skips a file that already exists.
- `-c` asks for only the missing end of a partly downloaded file and appends it.
- `-N` downloads only when the server's copy is newer than the local one.

A saved file takes the server's `Last-Modified` time.

**Output.** On a terminal there is a progress bar. `-nv` prints one line per file, and `-q` prints nothing. `-S` shows the response headers, and `--spider` checks that a URL exists without downloading it.

**Recursion.** `-r` follows the links of the HTML pages it downloads, on the same host, `-l` levels deep (5 by default). Files are saved under `HOST/PATH`. `-nH` leaves out the host directory and `-nd` the directories. `-np` stays below the starting directory, and `-A` and `-R` accept or reject files by suffix.

**What the browser decides.** The browser chooses what may be fetched. A site that does not allow cross-origin requests cannot be reached from a page, and wget reports this as a failed connection. Names are not looked up, so there is no "Resolving" line. A loopback URL (`http://localhost:8000/`) is not the browser's: it is fetched over a socket of this machine, so a server running here answers. The browser may refuse `-U`, since it sets the User-Agent itself. Certificates are always the browser's to check.

## Exit status

```
0  success
1  a generic error, such as a bad URL
2  a usage error
3  a file could not be written
4  a network failure
8  the server answered with an error (404 and the like)
```

## Options

```
  -O, --output-document=FILE   write documents to FILE (- for standard output)
  -P, --directory-prefix=DIR   save files under DIR
  -c, --continue               resume a partly downloaded file
  -N, --timestamping           only download what is newer than the local file
  -nc, --no-clobber            skip files that already exist
  -q, --quiet / -nv, --no-verbose
  -o, --output-file=FILE / -a, --append-output=FILE   log to FILE
  -i, --input-file=FILE        download the URLs in FILE
  -t, --tries=N                tries for a request that times out (20)
  -T, --timeout=SECONDS        give up on a request after SECONDS
  -S, --server-response        show the response headers
      --spider                 only check that the URLs exist
  -U, --user-agent=AGENT       --header=STRING   --method=METHOD
      --post-data=STRING       --post-file=FILE
  -r, --recursive   -l, --level=N   -np, --no-parent   -nd   -nH
  -A, --accept=LIST            -R, --reject=LIST
```

## See also

`curl`, `fetch`
