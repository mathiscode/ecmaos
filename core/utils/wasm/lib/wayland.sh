#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of Wayland clients: builds libwayland-client 1.26.0 (MIT) as a static library into
# "$1/prefix", with the client headers and the host's `wayland-scanner` output for wayland.xml. libffi is not used:
# the one place libwayland needs it (calling a listener with a message's arguments) becomes a switch on the argument
# count, which is exact here because every Wayland argument is one 32-bit word on wasm32.
# Sets WAYLAND_INC and WAYLAND_LIB for the caller. `wayland_protocol NAME XML` writes NAME-client-protocol.h and
# NAME-protocol.c into "$1/protocols" (for xdg-shell and the like).
set -euo pipefail

WAYLAND=1.26.0
WAYLAND_SHA256=64176eaa46e4969903e286f8e5ef8331affc17fdf03ac9b58381d2b23162b7a3

build_wayland() {
  local work=$1
  command -v wayland-scanner > /dev/null || { echo "wayland: needs the host wayland-scanner" >&2; exit 1; }
  ( cd "$work"
    curl -fsSL -o wayland.tar.xz "https://gitlab.freedesktop.org/wayland/wayland/-/releases/$WAYLAND/downloads/wayland-$WAYLAND.tar.xz"
    echo "$WAYLAND_SHA256  wayland.tar.xz" | sha256sum -c -
    tar xf wayland.tar.xz
    mkdir -p prefix/include prefix/lib protocols
    cd "wayland-$WAYLAND"
    S=$PWD/src
    mkdir -p gen
    : > config.h # nothing to switch on: no accept4, no ucred, no memfd in the client
    sed -e "s/@WAYLAND_VERSION@/$WAYLAND/" -e 's/@WAYLAND_VERSION_MAJOR@/1/' -e 's/@WAYLAND_VERSION_MINOR@/26/' -e 's/@WAYLAND_VERSION_MICRO@/0/' \
      "$S/wayland-version.h.in" > gen/wayland-version.h
    wayland-scanner -s client-header protocol/wayland.xml gen/wayland-client-protocol.h
    wayland-scanner -s public-code protocol/wayland.xml gen/wayland-protocol.c

    # wl_closure_invoke without libffi: cases for 0..WL_CLOSURE_MAX_ARGS arguments, all words.
    {
      echo '#include <stdint.h>'
      echo 'typedef uintptr_t W;'
      echo 'static void call_words(void (*f)(void), int n, const W *a) {'
      echo '  switch (n) {'
      for n in $(seq 0 22); do
        params=void
        args=
        if [ "$n" -gt 0 ]; then
          params=W
          args='a[0]'
          for i in $(seq 1 $((n - 1))); do params="$params,W"; args="$args,a[$i]"; done
        fi
        echo "  case $n: ((void (*)($params))f)($args); break;"
      done
      echo '  }'
      echo '}'
    } > gen/call-words.h

    python3 - "$S/connection.c" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('#include <ffi.h>', '#include "call-words.h"')
start = s.index('static void\nconvert_arguments_to_ffi')
end = s.index('void\nwl_closure_dispatch')
new = '''void
wl_closure_invoke(struct wl_closure *closure, uint32_t flags,
		  struct wl_object *target, uint32_t opcode, void *data)
{
	int count = arg_count_for_signature(closure->message->signature);
	uintptr_t words[WL_CLOSURE_MAX_ARGS + 2];
	void (* const *implementation)(void) = target->implementation;
	const char *sig_iter = closure->message->signature;
	struct argument_details arg;
	int i;

	words[0] = (uintptr_t) data;
	words[1] = (uintptr_t) target;
	for (i = 0; i < count; i++) {
		sig_iter = get_next_argument(sig_iter, &arg);
		switch (arg.type) {
		case WL_ARG_INT: words[i + 2] = (uintptr_t) closure->args[i].i; break;
		case WL_ARG_UINT: words[i + 2] = (uintptr_t) closure->args[i].u; break;
		case WL_ARG_FIXED: words[i + 2] = (uintptr_t) closure->args[i].f; break;
		case WL_ARG_STRING: words[i + 2] = (uintptr_t) closure->args[i].s; break;
		case WL_ARG_OBJECT: words[i + 2] = (uintptr_t) closure->args[i].o; break;
		case WL_ARG_NEW_ID:
			words[i + 2] = (flags & WL_CLOSURE_INVOKE_CLIENT) ? (uintptr_t) closure->args[i].o : (uintptr_t) closure->args[i].n;
			break;
		case WL_ARG_ARRAY: words[i + 2] = (uintptr_t) closure->args[i].a; break;
		case WL_ARG_FD: words[i + 2] = (uintptr_t) closure->args[i].h; break;
		default: wl_abort("unknown type\\n"); break;
		}
	}

	if (!implementation) {
		wl_abort("Implementation of resource %d of %s is NULL\\n",
			  target->id, target->interface->name);
	}
	if (!implementation[opcode]) {
		wl_abort("listener function for opcode %u of %s is NULL\\n",
			 opcode, target->interface->name);
	}
	call_words(implementation[opcode], count + 2, words);

	wl_closure_clear_fds(closure);
}

'''
s = s[:start] + new + s[end:]
open(p, 'w').write(s)
PY

    CFLAGS="-O2 -fwasm-exceptions -DHAVE_CONFIG_H -I. -Igen -I$S"
    for f in connection wayland-client wayland-os wayland-util; do
      emcc $CFLAGS -c "$S/$f.c" -o "gen/$f.o" > "gen/$f.log" 2>&1 || { tail -30 "gen/$f.log" >&2; exit 1; }
    done
    emcc $CFLAGS -I"$S" -c gen/wayland-protocol.c -o gen/wayland-protocol.o
    emar rcs "$work/prefix/lib/libwayland-client.a" gen/*.o
    cp "$S/wayland-client.h" "$S/wayland-client-core.h" "$S/wayland-util.h" gen/wayland-client-protocol.h gen/wayland-version.h "$work/prefix/include/"
  )
  WAYLAND_INC="-I$work/prefix/include"
  WAYLAND_LIB="-L$work/prefix/lib -lwayland-client"
}

# wayland_protocol WORK NAME XML: the client header and code for a protocol, in "$WORK/protocols".
wayland_protocol() {
  wayland-scanner -s client-header "$3" "$1/protocols/$2-client-protocol.h"
  wayland-scanner -s private-code "$3" "$1/protocols/$2-protocol.c"
}
