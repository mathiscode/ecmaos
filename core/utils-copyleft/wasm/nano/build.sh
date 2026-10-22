#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/nano.wasm: GNU nano 9.2 for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
#
# Needs the host's `tic` and `infocmp` (ncurses builds its fallback terminal descriptions with them). The result is
# committed, so only run this to change it. nano draws with ncurses, which is built here too, as a static
# wide-character library with the xterm, xterm-256color, vt100 and linux descriptions compiled in (there is no
# terminfo database to read), as ../../../utils/wasm/lib/ncurses.sh builds it for the other curses programs.
#
# What is changed in nano's source, each asserted so a new release that moves the code fails the build:
#   - main() starts by setting TERM and SHELL: TERM is `xterm.js`, a name none of those descriptions have, so nano
#     falls back to xterm-256color for it; SHELL, which runs an executed command, is the kernel's own shell (`ecmaos`)
#     unless the login shell is a program, and it has no file to run, so nano is given /bin/sh then.
#   - there is no fork, so the three places nano forks a program start it with posix_spawn, its descriptors set up by
#     file actions as the forked child set them up: an executed command (^T), the formatter and the linter. A
#     formatter or linter that cannot be started is reported as one that could not be run.
#   - the text an executed command filters (^T with `|`) was written to it by a second forked child, so the command's
#     output could be read at the same time; it is written by a thread instead, from a copy of the text made before,
#     with SIGPIPE ignored until it is done (a command that stops reading ends the writing, not nano).
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
NANO=$(node "$SOURCES" version nano nano)
NCURSES=$(node "$SOURCES" version nano ncurses)
NANO_ARCHIVE=$(node "$SOURCES" fetch nano nano)
NCURSES_ARCHIVE=$(node "$SOURCES" fetch nano ncurses)
OUT=$HERE/../../programs/nano.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$NCURSES_ARCHIVE"
tar xJf "$NANO_ARCHIVE"

mkdir prefix
cd "ncurses-$NCURSES"
CC="$WALI_CC" CFLAGS=-O2 AR="$WALI_AR" RANLIB="$WALI_RANLIB" ./configure --host=wasm32-unknown-linux-musl \
  --prefix="$WORK/prefix" --without-ada --without-cxx --without-cxx-binding --without-manpages --without-progs \
  --without-tests --without-shared --without-debug --disable-database --with-fallbacks=xterm-256color,xterm,vt100,linux \
  --with-tic-path="$(command -v tic)" --with-infocmp-path="$(command -v infocmp)" --without-gpm \
  --disable-stripping --enable-widec --disable-home-terminfo > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
# the build-time helpers (make_keys writes the key table: without it curses recognises no arrow or function key) are
# run here, so they are built with the host compiler
sed -i 's/^BUILD_CC\t= .*/BUILD_CC\t= cc/; s/^BUILD_CCFLAGS\t= .*/BUILD_CCFLAGS\t=/; s/^BUILD_LDFLAGS\t= .*/BUILD_LDFLAGS\t=/; s/^BUILD_LIBS\t= .*/BUILD_LIBS\t=/' ncurses/Makefile
make -j"$(nproc)" libs > make.log 2>&1 || true # the last step builds a host-side helper that does not run; the library is what we want
grep -q "KEY_A1" ncurses/init_keytry.h || { echo "ncurses: init_keytry.h is empty (the host helper make_keys did not run), so arrow keys would not work" >&2; exit 1; }
[ -f lib/libncursesw.a ] || { tail -30 make.log >&2; exit 1; }
make install.includes > /dev/null 2>&1
mkdir -p "$WORK/prefix/lib" && cp lib/libncursesw.a "$WORK/prefix/lib/"

cd "$WORK/nano-$NANO"
python3 - <<'PY'

def patch(path, old, new):
    text = open(path).read()
    assert text.count(old) == 1, 'nano source changed: %s no longer has %r' % (path, old[:70])
    open(path, 'w').write(text.replace(old, new, 1))

# TERM and SHELL
patch('src/nano.c', 'int main(int argc, char **argv)\n{\n', '''int main(int argc, char **argv)
{
	if (getenv("TERM") == NULL || strcmp(getenv("TERM"), "xterm.js") == 0)
		setenv("TERM", "xterm-256color", 1);
	if (getenv("SHELL") != NULL && *getenv("SHELL") != '/')
		setenv("SHELL", "/bin/sh", 1);

''')

# an executed command: the command, and the thread that sends it the text it filters
patch('src/files.c', '/* Send the text that starts at the given line to file descriptor fd. */\n', '''/* The text an executed command filters, which a thread writes to it. */
static struct {
	int fd;
	char *text;
	size_t length;
} sending;
static pthread_t sender;
static bool sender_running = FALSE;

/* A copy of the text that starts at the given line, as send_data() would send it. */
static char *copy_of_data(const linestruct *line, size_t *length)
{
	size_t size = 1, at = 0;
	char *text;

	for (const linestruct *each = line; each && (each->next || each->data[0]); each = each->next)
		size += strlen(each->data) + 1;
	text = nmalloc(size);

	/* Each line, except a final empty line, with its NULs back (nano keeps them as LFs). */
	while (line && (line->next || line->data[0])) {
		for (const char *c = line->data; *c; c++)
			text[at++] = (*c == '\\n') ? '\\0' : *c;
		if (line->next)
			text[at++] = '\\n';
		line = line->next;
	}

	*length = at;
	return text;
}

/* The sender thread: writes the copy, and closes the pipe. Its result is an exit status. */
static void *send_copy(void *unused)
{
	size_t done = 0;
	intptr_t status = 0;

	while (done < sending.length) {
		ssize_t count = write(sending.fd, sending.text + done, sending.length - done);

		if (count < 0 && errno == EINTR)
			continue;
		if (count < 0) {
			status = 5;
			break;
		}
		done += count;
	}

	close(sending.fd);
	return (void *)status;
}

/* Send the text that starts at the given line to file descriptor fd. */
''')
files = open('src/files.c').read()
start = files.index('\t/* Fork a child process to run the command in. */\n')
end = files.index('\t\texit(6);\n\t}\n', start) + len('\t\texit(6);\n\t}\n')
child = files[start:end]
for line in ('dup2(from_fd[1], STDOUT_FILENO)', 'dup2(from_fd[1], STDERR_FILENO)', 'dup2(to_fd[0], STDIN_FILENO)',
             'close(to_fd[1]);', 'execl(theshell, tail(theshell), "-c", should_pipe ? capture_output ?'):
    assert line in child, 'nano source changed: the forked command no longer does ' + line
files = files[:start] + '''\t/* Start the command in the preferred shell. */
\t{
\t\tconst char *theshell = getenv("SHELL");
\t\tposix_spawn_file_actions_t actions;
\t\tchar *arguments[4] = { NULL, "-c", NULL, NULL };
\t\tint error;

\t\tif (theshell == NULL)
\t\t\ttheshell = (char *)"/bin/sh";
\t\targuments[0] = (char *)tail(theshell);
\t\targuments[2] = (char *)(should_pipe ? capture_output ? &command[1] : &command[2] : command);

\t\tposix_spawn_file_actions_init(&actions);
\t\tposix_spawn_file_actions_addclose(&actions, from_fd[0]);
\t\tif (capture_output)
\t\t\tposix_spawn_file_actions_adddup2(&actions, from_fd[1], STDOUT_FILENO);
\t\tposix_spawn_file_actions_adddup2(&actions, from_fd[1], STDERR_FILENO);
\t\tif (should_pipe) {
\t\t\tposix_spawn_file_actions_adddup2(&actions, to_fd[0], STDIN_FILENO);
\t\t\tposix_spawn_file_actions_addclose(&actions, from_fd[1]);
\t\t\tposix_spawn_file_actions_addclose(&actions, to_fd[1]);
\t\t}
\t\terror = posix_spawn(&pid_of_command, theshell, &actions, NULL, arguments, environ);
\t\tposix_spawn_file_actions_destroy(&actions);
\t\tif (error != 0) {
\t\t\tpid_of_command = -1;
\t\t\terrno = error;
\t\t}
\t}
''' + files[end:]
open('src/files.c', 'w').write(files)
patch('src/files.c', '''		/* Create a separate process for piping the data to the command. */
		if ((pid_of_sender = fork()) == 0) {
			send_data(whole_buffer ? openfile->filetop : cutbuffer, to_fd[1]);
			exit(0);
		}

		if (pid_of_sender < 0)
			statusline(ALERT, _("Could not fork: %s"), strerror(errno));
''', '''		/* Have a thread send a copy of the data to the command. */
		sending.fd = to_fd[1];
		sending.text = copy_of_data(whole_buffer ? openfile->filetop : cutbuffer, &sending.length);
		signal(SIGPIPE, SIG_IGN);
		sender_running = (pthread_create(&sender, NULL, send_copy, NULL) == 0);
		if (!sender_running) {
			statusline(ALERT, _("Could not fork: %s"), strerror(errno));
			close(to_fd[1]);
		}
''')
patch('src/files.c', '''		close(to_fd[0]);
		close(to_fd[1]);
''', '''		close(to_fd[0]);
''')
patch('src/files.c', '''	if (should_pipe && pid_of_sender > 0)
		waitpid(pid_of_sender, &sender_status, 0);
''', '''	if (should_pipe && sender_running) {
		void *result;

		pthread_join(sender, &result);
		sender_status = (int)(intptr_t)result << 8;
		signal(SIGPIPE, SIG_DFL);
		free(sending.text);
	} else if (should_pipe)
		free(sending.text);
''')
patch('src/files.c', '''	else if (should_pipe && pid_of_sender > 0 &&''', '''	else if (should_pipe && sender_running &&''')
patch('src/files.c', '#include <pwd.h>\n', '#include <pwd.h>\n#include <pthread.h>\n#include <spawn.h>\n#include <stdint.h>\nextern char **environ;\n')

# the formatter
patch('src/text.c', '''	if ((thepid = fork()) == 0) {
		execvp(arguments[0], arguments);

		/* Terminate the child if the program is not found. */
		exit(9);
	} else if (thepid > 0) {''', '''	if (posix_spawnp(&thepid, arguments[0], NULL, NULL, arguments, environ) != 0) {
		/* What the forked child exited with when the program was not found. */
		thepid = 0;
		program_status = 9 << 8;
	} else {''')

# the linter
text = open('src/text.c').read()
start = text.index('\tif ((pid_lint = fork()) == 0) {\n')
end = text.index('\t\texit(9);\n\t}\n', start) + len('\t\texit(9);\n\t}\n')
child = text[start:end]
for line in ('dup2(lint_fd[1], STDOUT_FILENO)', 'dup2(lint_fd[1], STDERR_FILENO)',
             'construct_argument_list(&lintargs, openfile->syntax->linter, openfile->filename);', 'execvp(lintargs[0], lintargs);'):
    assert line in child, 'nano source changed: the forked linter no longer does ' + line
text = text[:start] + '''\t{
\t\tchar **lintargs = NULL;
\t\tposix_spawn_file_actions_t actions;
\t\tint error;

\t\tconstruct_argument_list(&lintargs, openfile->syntax->linter, openfile->filename);
\t\tposix_spawn_file_actions_init(&actions);
\t\tposix_spawn_file_actions_adddup2(&actions, lint_fd[1], STDOUT_FILENO);
\t\tposix_spawn_file_actions_adddup2(&actions, lint_fd[1], STDERR_FILENO);
\t\tposix_spawn_file_actions_addclose(&actions, lint_fd[0]);
\t\tposix_spawn_file_actions_addclose(&actions, lint_fd[1]);
\t\terror = posix_spawnp(&pid_lint, lintargs[0], &actions, NULL, lintargs, environ);
\t\tposix_spawn_file_actions_destroy(&actions);
\t\tfree(lintargs[0]);
\t\tfree(lintargs);
\t\tif (error != 0) {
\t\t\tstatusline(ALERT, _("Error invoking '%s'"), openfile->syntax->linter);
\t\t\tclose(lint_fd[0]);
\t\t\tclose(lint_fd[1]);
\t\t\treturn;
\t\t}
\t}
''' + text[end:]
text = text.replace('#include <errno.h>\n', '#include <errno.h>\n#include <spawn.h>\nextern char **environ;\n', 1)
assert '#include <spawn.h>' in text
open('src/text.c', 'w').write(text)
PY
INC="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw"
CC="$WALI_CC" CFLAGS="-O2 $INC" LDFLAGS="-L$WORK/prefix/lib" NCURSESW_CFLAGS="$INC" NCURSESW_LIBS="-lncursesw" \
  ./configure --host=wasm32-unknown-linux-musl --sysconfdir=/etc --disable-nls --enable-utf8 --disable-speller \
  --disable-browser --disable-libmagic > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp src/nano "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
