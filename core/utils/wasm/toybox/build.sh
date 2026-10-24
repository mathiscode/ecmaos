#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/<command>.wasm for each toybox (0BSD) command named, by default `patch`, `microcom`, `hwclock` and the
# readers of /proc and /sys (`ps`, `lsof`, `vmstat`, `netstat`, `sysctl`, `lsmod`, `pidof`, `lsusb`, `lspci`), for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. The GNU patch is GPL; this is the permissive one. `microcom` is the serial
# console (`microcom -s 115200 /dev/ttyACM0`), `hwclock` reads /dev/rtc0. Toybox builds one command on its own with
# scripts/single.sh; it targets Linux, which WALI's musl is, so it builds as it is. One source change: toybox calls its
# exit handlers through `void (*)(int)` but declares `tempfile_handler(void)`, which a native ABI tolerates and
# WebAssembly traps on, so it is given the parameter.
#
#   build.sh                  patch, microcom, hwclock, ps, lsof, vmstat, netstat, sysctl, lsmod, pidof, lsusb and lspci
#   build.sh microcom         just the commands named
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=0.8.12
SHA256=ad88a921133ae2231d9f2df875ec0bd42af4429145caea7d7db9e02208a6fd2e
HERE=$(cd "$(dirname "$0")" && pwd)
COMMANDS=("$@")
[ ${#COMMANDS[@]} -gt 0 ] || COMMANDS=(patch microcom hwclock ps lsof vmstat netstat sysctl lsmod pidof lsusb lspci)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o toybox.tar.gz "https://landley.net/toybox/downloads/toybox-$VERSION.tar.gz"
echo "$SHA256  toybox.tar.gz" | sha256sum -c -
tar xzf toybox.tar.gz
cd "toybox-$VERSION"

grep -q '^static void tempfile_handler(void)$' lib/lib.c || { echo "toybox source changed: tempfile_handler not found" >&2; exit 1; }
sed -i 's/^static void tempfile_handler(void)$/static void tempfile_handler(int sig)/' lib/lib.c

# Toybox keeps what an option takes in the command's GLOBALS struct and fills it as an array of `long`, which is right only
# where a `long` and a pointer are the same size. WALI's `long` is 8 bytes and its pointer 4, so a string or list option
# (`ps -o`, `-p`, `-u`) landed in the wrong member. Each slot is given the size and alignment its member has: a pointer
# (type `:` or `*`) 4, anything else (`#`, `-`, `%`, `@`, `.`) 8, as the compiler lays the struct out.
python3 - <<'PATCH'
path = "lib/args.c"
source = open(path).read()
def swap(old, new):
    global source
    assert source.count(old) == 1, old
    source = source.replace(old, new)
swap("// Linked list of all known options (option string parsed into this).",
     "// A slot holds a pointer (4 bytes under WALI) for type : and *, a long (8) otherwise\n"
     "#define SLOT_IS_POINTER(type) ((type) == ':' || (type) == '*')\n"
     "#define SLOT_SET(opt, value) do { if (SLOT_IS_POINTER((opt)->type)) *(void **)(opt)->arg = (void *)(long)(value); else *(opt)->arg = (value); } while (0)\n\n"
     "// Linked list of all known options (option string parsed into this).")
swap("    if (opt->type=='*') llist_traverse((void *)*opt->arg, free);\n    *opt->arg = opt->val[2].l;",
     "    if (opt->type=='*') llist_traverse(*(void **)opt->arg, free);\n    SLOT_SET(opt, opt->val[2].l);")
swap("if (type == ':') *(opt->arg) = (long)arg;", "if (type == ':') *(char **)opt->arg = arg;")
swap("  long *nextarg = (long *)&this;", "  size_t slot = 0;")
swap("      new->arg = (void *)nextarg;\n      *(nextarg++) = new->val[2].l;",
     "      size_t size = SLOT_IS_POINTER(new->type) ? sizeof(void *) : sizeof(long);\n\n"
     "      slot = (slot + size - 1) & ~(size - 1);\n"
     "      new->arg = (void *)((char *)&this + slot);\n"
     "      slot += size;\n"
     "      SLOT_SET(new, new->val[2].l);")
open(path, "w").write(source)
PATCH

# `ps aux`, which toybox leaves as a TODO: a first argument of only a, u, x and w (BSD style, no dash) is -e (every process),
# and with a `u` the user-oriented columns. The argument vector is rewritten before the options are read.
grep -q '^  toys.argv = argv;$' main.c || { echo "toybox source changed: toy_singleinit not found" >&2; exit 1; }
python3 - <<'PATCH'
path = "main.c"
source = open(path).read()
hook = "  toys.argv = argv;\n"
fix = '''  toys.argv = argv;

  if (!strcmp(which->name, "ps") && argv[1] && argv[1][0] && argv[1][0] != '-' && !argv[1][strspn(argv[1], "auxw")]) {
    int count = 0, all = 0, user = 0, i;
    char **fixed;

    for (i = 0; argv[1][i]; i++) {
      if (argv[1][i] == 'a' || argv[1][i] == 'x') all = 1;
      if (argv[1][i] == 'u') user = 1;
    }
    while (argv[count]) count++;
    fixed = xmalloc((count + 4) * sizeof(char *));
    count = 0;
    fixed[count++] = argv[0];
    if (all) fixed[count++] = "-e";
    if (user) {
      fixed[count++] = "-o";
      fixed[count++] = "USER,PID,%CPU,%MEM,VSZ,RSS,TTY,STAT,STIME,TIME,ARGS";
    }
    for (i = 2; argv[i]; i++) fixed[count++] = argv[i];
    fixed[count] = 0;
    toys.argv = argv = fixed;
  }
'''
assert hook in source
open(path, "w").write(source.replace(hook, fix, 1))
PATCH

# STIME: toybox cuts the date to start `-3-width` characters from the end of "yyyy-mm-dd hh:mm:ss", which leaves hh:mm:ss
# for the default width of 5, and a right-justified field on a terminal keeps the right end, so it printed mm:ss. The
# seconds are cut off first (kept only at the full width of 19), as the comment above that line means.
python3 - <<'PATCH'
path = "toys/posix/ps.c"
source = open(path).read()
old = """    out = out+strlen(out)-3-abs(field->len);
    if (out<buf) out = buf;"""
new = """    if (abs(field->len) < 19) out[16] = 0;
    out = out+strlen(out)-abs(field->len);
    if (out<buf) out = buf;"""
assert source.count(old) == 1
open(path, "w").write(source.replace(old, new))
PATCH

for command in "${COMMANDS[@]}"; do
  OUT=$HERE/../../programs/$command.wasm
  CC=$WALI_CC HOSTCC=cc NOSTRIP=1 CFLAGS="-O2" LDOPTIMIZE="-Wl,--gc-sections" \
    scripts/single.sh "$command" > "build-$command.log" 2>&1 || { tail -30 "build-$command.log" >&2; exit 1; }
  cp "generated/unstripped/$command" "$OUT"
  ls -l "$OUT"
done
echo "built with $WALI_TOOLCHAIN"
