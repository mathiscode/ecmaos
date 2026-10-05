# SPDX-License-Identifier: MIT OR Apache-2.0
# What is frozen into /bin/micropython: asyncio from the MicroPython tree, and pure-Python modules from micropython-lib
# (lib/micropython-lib in the release tarball). textwrap is not among them: it compiles regexes with lookahead and
# lookbehind at import, which MicroPython's re does not support, so it cannot even be imported. Left out on purpose: mip and ssl (the stock manifest freezes them; both
# need sockets), threading, and anything else that cannot work here.

include("$(MPY_DIR)/extmod/asyncio")

# `os` here replaces the built-in module with one that adds os.path, os.walk and a stat_result named tuple.
require("os-path")

# Derived from CPython, so under the Python License rather than MIT (licenses/micropython/LICENSE-micropython-lib has both).
require("argparse")
require("contextlib")
require("copy")
require("datetime")
require("shutil")
require("unittest")

require("bisect")
require("collections")
require("collections-defaultdict")
require("fnmatch")
require("functools")
require("heapq")
require("itertools")
require("logging")
require("operator")
require("pathlib")
require("random")
require("stat")
require("string")
require("tempfile")
require("time")
require("traceback")
require("types")
require("warnings")
