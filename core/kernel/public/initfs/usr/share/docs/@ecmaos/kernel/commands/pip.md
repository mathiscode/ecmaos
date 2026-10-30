# pip

`man @ecmaos/kernel/commands/pip`

## Synopsis

```
pip install [-U] [--user] [--no-deps] [--pre] [--force-reinstall] [--dry-run] [-r FILE] REQUIREMENT...
pip uninstall [-y] PACKAGE...
pip list [--outdated] [--format freeze|json]    pip freeze    pip show [-f] PACKAGE...    pip check
pip index versions PACKAGE    pip cache dir|info|purge    pip config list
```

## Description

Python's package installer, on PyPI. `pip install requests` resolves `requests` and what it needs (`Requires-Dist`, with the environment markers evaluated for this machine: Linux, `wasm32`, CPython at the version installed in `/usr/lib/python3.N`), picks for each project the highest release that meets every range asked of it (no yanked releases, no pre-releases unless `--pre` or pinned), fetches the wheels, checks each against the SHA-256 PyPI publishes, and unpacks them the way pip does: the package into `site-packages`, a wheel's `scripts` into the bin directory with their `#!python` line made `#!/usr/bin/env python3`, `console_scripts` as small launchers, `headers` and `data` under the prefix. `--index-url` (or `$PIP_INDEX_URL`) names another index with PyPI's JSON API. A REQUIREMENT is also a local `.whl` file or the URL of one.

root installs into `/usr/lib/python3.N/site-packages` and `/usr/bin`; anyone else, or `--user`, into `~/.local/lib/python3.N/site-packages` and `~/.local/bin` (pip says `Defaulting to user installation`). The state is Python's own: each package has a `NAME-VERSION.dist-info` directory with `METADATA`, `RECORD`, `INSTALLER` and, for what was asked for by name, `REQUESTED`, so `importlib.metadata` and other tools see the same packages as `pip list`. `pip` keeps no database of its own, and (unlike `install`) no list of dependencies to remove: `pip uninstall` removes the files in a package's `RECORD`, its compiled bytecode and the directories that empties, and nothing else. Downloaded wheels and index pages are cached under `/var/cache/install/pip` (or `~/.cache/install/pip`); `--offline` uses only the cache.

Only pure-Python wheels can be installed. A project with only native wheels (compiled for a processor and a C library ecmaOS does not have), or only source distributions (nothing here builds from source), is refused with the reason, and so is a directory, an archive or a VCS URL. `pip search` is gone from PyPI and says so. `download`, `wheel`, `hash` and `debug` are not there. Python and its standard library come with ecmaOS (`python3`); pip itself is this command, not a Python module, so `python3 -m pip` does not work.

## See also

[`install`](install.md), [`npm`](npm.md), `python3`
