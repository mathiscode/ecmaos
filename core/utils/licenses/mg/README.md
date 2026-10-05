# mg

mg (the portable build of OpenBSD's editor) is in the public domain: its README says so, and the source files say so
too (excerpt in `README-excerpt.txt`). Parts compiled into `mg.wasm` that are not:

- `recallocarray.c`, from OpenBSD: ISC license (`recallocarray-ISC.txt`).
- `sys/queue.h` (BSD-3-Clause, from the Regents of the University of California; `queue.h-BSD-3-Clause.txt`) and
  `sys/tree.h` (BSD-2-Clause, from OpenBSD; `tree.h-BSD-2-Clause.txt`): macro headers vendored under `wasm/mg/compat/`.
- ncurses, linked statically: X11 license (`../ncurses/COPYING`).
