#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/mg.wasm: mg, the small Emacs-style editor from OpenBSD (portable version: public domain with
# ISC/BSD-licensed files), for ecmaOS, on WALI's musl (`utils/check-wali.sh`) with ncurses (see ../lib/ncurses.sh), run
# by /bin/wali. Built straight from the file list in the source's GNUmakefile. `compat/` has what musl lacks that mg
# expects from libbsd: the BSD <sys/queue.h> and <sys/tree.h>, strtonum() and fparseln(). Batch mode's pty
# (openpty, login_tty) is musl's own. Two source changes:
# - TERM: mg starts curses without looking at it, and this terminal is `xterm.js`, which has no terminfo entry, so it
#   is given xterm-256color. SHELL, which shell-command runs, is the kernel's own shell (`ecmaos`) unless the login
#   shell is a program; it has no file to run, so mg is given /bin/sh then.
# - there is no fork, so the two places mg forks a command (dired's d_exec, and pipeio for shell-command and
#   shell-command-on-region) start it with posix_spawn, its descriptors set up by file actions as the forked child
#   set them up itself.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=20260719
SHA256=8ca736b1e57d9681e7921d37b9cf0282e3098e2929ed37384400c78dae54762d
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/mg.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
source "$HERE/../lib/ncurses.sh"

cd "$WORK"
curl -fsSL -o mg.tar.gz "https://github.com/hboetes/mg/archive/refs/tags/$VERSION.tar.gz"
echo "$SHA256  mg.tar.gz" | sha256sum -c -
tar xzf mg.tar.gz
build_ncurses "$WORK" wali

cd "mg-$VERSION"
python3 - <<'PY'
import re
p = 'main.c'
s = open(p).read()
m = re.search(r'\nmain\(int argc, char \*\*argv\)\n\{\n', s)
assert m, "mg source changed: main() not found"
s = s[:m.end()] + '\tif (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js"))\n\t\tsetenv("TERM", "xterm-256color", 1);\n' \
    + '\tif (getenv("SHELL") && *getenv("SHELL") != \'/\')\n\t\tsetenv("SHELL", "/bin/sh", 1);\n' + s[m.end():]
open(p, 'w').write(s)

def patch(path, old, new):
    s = open(path).read()
    assert s.count(old) == 1, f"mg source changed: {path} no longer has the code patched here"
    open(path, 'w').write(s.replace(old, new))

spawn_includes = '#include <spawn.h>\nextern char **environ;\n#include "def.h"\n'
patch('dired.c', '#include "def.h"\n', spawn_includes)
patch('dired.c', '''	if ((pid = fork()) == -1) {
		dobeep();
		ewprintf("Can't fork");
		goto out;
	}

	switch (pid) {
	case 0: /* Child */
		close(fds[0]);
		dup2(infd, STDIN_FILENO);
		dup2(fds[1], STDOUT_FILENO);
		dup2(fds[1], STDERR_FILENO);
		if (execvp(argv[0], argv) == -1)
			ewprintf("Can't exec %s: %s", argv[0], strerror(errno));
		exit(1);
		break;
	default: /* Parent */''', '''	posix_spawn_file_actions_t fa;
	if (posix_spawn_file_actions_init(&fa) != 0) {
		dobeep();
		ewprintf("Can't fork");
		goto out;
	}
	posix_spawn_file_actions_addclose(&fa, fds[0]);
	posix_spawn_file_actions_adddup2(&fa, infd, STDIN_FILENO);
	posix_spawn_file_actions_adddup2(&fa, fds[1], STDOUT_FILENO);
	posix_spawn_file_actions_adddup2(&fa, fds[1], STDERR_FILENO);
	n = posix_spawnp(&pid, argv[0], &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	if (n != 0) {
		dobeep();
		ewprintf("Can't exec %s: %s", argv[0], strerror(n));
		goto out;
	}

	switch (pid) {
	default: /* Parent */''')
patch('region.c', '#include "def.h"\n', spawn_includes)
patch('region.c', '''	switch((pid = fork())) {
	case -1:
		dobeep();
		ewprintf("Can't fork");
		return (FALSE);
	case 0:
		/* Child process */
		close(s[0]);
		if (dup2(s[1], STDIN_FILENO) == -1)
			_exit(1);
		if (dup2(s[1], STDOUT_FILENO) == -1)
			_exit(1);
		if (dup2(s[1], STDERR_FILENO) == -1)
			_exit(1);

		execv(path, argv);
		err = strerror(errno);
		write(s[1], err, strlen(err));
		_exit(1);
	default:''', '''	posix_spawn_file_actions_t fa;
	if (posix_spawn_file_actions_init(&fa) != 0) {
		close(s[0]);
		close(s[1]);
		dobeep();
		ewprintf("Can't fork");
		return (FALSE);
	}
	posix_spawn_file_actions_addclose(&fa, s[0]);
	posix_spawn_file_actions_adddup2(&fa, s[1], STDIN_FILENO);
	posix_spawn_file_actions_adddup2(&fa, s[1], STDOUT_FILENO);
	posix_spawn_file_actions_adddup2(&fa, s[1], STDERR_FILENO);
	ret = posix_spawn(&pid, path, &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	/* what the child said when it could not run the command: here, the reason it could not be started */
	if (ret != 0) {
		err = strerror(ret);
		write(s[1], err, strlen(err));
		close(s[1]);
		undo_boundary_enable(FFRAND, 0);
		ret = iomux(s[0], NULL, 0);
		undo_boundary_enable(FFRAND, 1);
		return (ret);
	}

	switch (pid) {
	default:''')
PY
SOURCES=$(sed -n '/^OBJS=/,/^OBJS+=/p' GNUmakefile | tr -d '\\' | grep -oE '[a-z_]+\.o' | sed 's/\.o$/.c/' | tr '\n' ' ')
"$WALI_CC" -O2 -DREGEX -D_GNU_SOURCE -Wno-deprecated-declarations -include "$HERE/compat/bsd.h" -I"$HERE/compat" $NCURSES_INC \
  $SOURCES recallocarray.c "$HERE/compat/bsd.c" -o mg.wasm $NCURSES_LIB -lncursesw \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp mg.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
