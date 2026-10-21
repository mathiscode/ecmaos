/* SPDX-License-Identifier: MIT OR Apache-2.0
 * Processes for Emscripten programs: posix_spawn, execve, wait4, kill and the process ids, on the kernel's process
 * calls. There is no fork here; posix_spawn hands the whole request to the host, which starts the child as a new
 * process with a copy of this one's descriptor table (close-on-exec flags and all) and the file actions replayed on
 * it: the same host call WALI's musl makes (utils/wali/patches/musl/0005-posix-spawn-through-the-host.patch).
 * Emscripten's libc has no posix_spawn, execve or popen, runs system() through a host call, and answers the process ids and wait4 with stand-ins
 * (every program is pid 42 and has no children); these definitions replace them. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include "imports.h"

extern char **__environ;

/* musl's file action (src/process/fdop.h), the list posix_spawn_file_actions_t holds */
#define FDOP_CLOSE 1
struct fdop {
	struct fdop *next, *prev;
	int cmd, fd, srcfd, oflag;
	mode_t mode;
	char path[];
};

static long fail(long value) {
	if (value >= 0) return value;
	errno = -value;
	return -1;
}

/* The file posix_spawnp's search finds for `file`: the first entry of PATH it is executable in */
static int search(const char *file, char *buf) {
	const char *path = getenv("PATH");
	size_t length = strnlen(file, NAME_MAX + 1);
	int denied = 0;
	if (!path) path = "/usr/local/bin:/bin:/usr/bin";
	if (length > NAME_MAX) return ENAMETOOLONG;
	for (const char *p = path, *z; ; p = z + 1) {
		z = strchrnul(p, ':');
		size_t dir = z - p;
		if (dir + length + 2 <= PATH_MAX) {
			memcpy(buf, p, dir);
			buf[dir] = '/';
			memcpy(buf + dir + (dir > 0), file, length + 1);
			if (!access(buf, X_OK)) return 0;
			if (errno == EACCES) denied = 1;
		}
		if (!*z) break;
	}
	return denied ? EACCES : ENOENT;
}

static int spawn(pid_t *restrict res, const char *restrict path, const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr, char *const argv[restrict], char *const envp[restrict], int searched) {
	static const posix_spawnattr_t none;
	const posix_spawnattr_t *a = attr ? attr : &none;
	char found[PATH_MAX];
	struct ecmaos_spawn_op *ops = 0;
	struct fdop *op;
	int count = 0, ec;

	if (searched && !strchr(path, '/')) {
		if (!*path) return ENOENT;
		if ((ec = search(path, found))) return ec;
		path = found;
	}

	/* the list's head is the action added last, and each is applied in the order it was added */
	if (fa) for (op = fa->__actions; op; op = op->next) count++;
	if (count && !(ops = malloc(count * sizeof *ops))) return ENOMEM;
	int i = count;
	if (fa) for (op = fa->__actions; op; op = op->next)
		ops[--i] = (struct ecmaos_spawn_op){ op->cmd, op->fd, op->srcfd, op->oflag, op->mode, op->path };

	__ecmaos_publish_signals();
	long pid = __ecmaos_spawn(path, argv, envp ? envp : __environ, ops, count, a->__flags, a->__pgrp, &a->__def, &a->__mask);
	free(ops);
	if (pid < 0) return -pid;
	if (res) *res = pid;
	return 0;
}

int posix_spawn(pid_t *restrict res, const char *restrict path, const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr, char *const argv[restrict], char *const envp[restrict]) {
	return spawn(res, path, fa, attr, argv, envp, 0);
}

int posix_spawnp(pid_t *restrict res, const char *restrict file, const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr, char *const argv[restrict], char *const envp[restrict]) {
	return spawn(res, file, fa, attr, argv, envp, 1);
}

/* execve: descriptors marked close-on-exec go, and the ignored signals and the mask carry over to the new image */
int execve(const char *path, char *const argv[], char *const envp[]) {
	__ecmaos_publish_signals();
	return fail(__ecmaos_execve(path, argv, envp ? envp : __environ));
}

/* (execv, execvp, execl and the others are libc's, on top of execve) */

/* there is no fork: a program that can do without it (most fall back to posix_spawn or system) is told so */
pid_t fork(void) { errno = ENOSYS; return -1; }
pid_t vfork(void) { errno = ENOSYS; return -1; }

/* the kernel keeps no resource usage: a child's is all zeros */
pid_t __syscall_wait4(pid_t pid, int *status, int options, struct rusage *usage) {
	if (usage) memset(usage, 0, sizeof *usage);
	return __ecmaos_wait4(pid, status, options);
}
pid_t __syscall_getpid(void) { return __ecmaos_getpid(); }
pid_t __syscall_getppid(void) { return __ecmaos_getppid(); }
pid_t __syscall_getpgid(pid_t pid) { return __ecmaos_getpgid(pid); }
int __syscall_setpgid(pid_t pid, pid_t pgid) { return __ecmaos_setpgid(pid, pgid); }
pid_t __syscall_getsid(pid_t pid) { return __ecmaos_getsid(pid); }
pid_t __syscall_setsid(void) { return __ecmaos_setsid(); }

/* a signal this process sends itself is raised here, so a handler has run before kill returns, as on Linux */
int kill(pid_t pid, int sig) {
	if (pid == getpid() && sig > 0) return raise(sig);
	return fail(__ecmaos_kill(pid, sig));
}

/* system: `sh -c` in the caller's process group, as musl's, with SIGINT and SIGQUIT ignored and SIGCHLD blocked here
 * while it runs (Emscripten's goes to a host call that has no signals to set) */
int system(const char *cmd) {
	pid_t pid;
	sigset_t old, reset;
	struct sigaction sa = { .sa_handler = SIG_IGN }, oldint, oldquit;
	int status = -1, ret;
	posix_spawnattr_t attr;

	if (!cmd) return 1;

	sigaction(SIGINT, &sa, &oldint);
	sigaction(SIGQUIT, &sa, &oldquit);
	sigaddset(&sa.sa_mask, SIGCHLD);
	sigprocmask(SIG_BLOCK, &sa.sa_mask, &old);

	sigemptyset(&reset);
	if (oldint.sa_handler != SIG_IGN) sigaddset(&reset, SIGINT);
	if (oldquit.sa_handler != SIG_IGN) sigaddset(&reset, SIGQUIT);
	posix_spawnattr_init(&attr);
	posix_spawnattr_setsigmask(&attr, &old);
	posix_spawnattr_setsigdefault(&attr, &reset);
	posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK);
	ret = posix_spawn(&pid, "/bin/sh", 0, &attr, (char *[]){ "sh", "-c", (char *)cmd, 0 }, __environ);
	posix_spawnattr_destroy(&attr);

	if (!ret) while (waitpid(pid, &status, 0) < 0 && errno == EINTR);
	sigaction(SIGINT, &oldint, 0);
	sigaction(SIGQUIT, &oldquit, 0);
	sigprocmask(SIG_SETMASK, &old, 0);

	if (ret) errno = ret;
	return status;
}

/* popen and pclose: `sh -c` with one end of a pipe as its stdin or stdout. Emscripten's FILE has no field for the
 * child, so the open streams and their children are kept here. */
static struct child { FILE *file; pid_t pid; struct child *next; } *children;

FILE *popen(const char *cmd, const char *mode) {
	int p[2], op, e;
	pid_t pid;
	FILE *f;
	posix_spawn_file_actions_t fa;
	struct child *entry;

	if (*mode == 'r') op = 0;
	else if (*mode == 'w') op = 1;
	else { errno = EINVAL; return 0; }

	if (!(entry = malloc(sizeof *entry))) return 0;
	if (pipe2(p, O_CLOEXEC)) { free(entry); return 0; }
	if (!(f = fdopen(p[op], mode))) {
		close(p[0]);
		close(p[1]);
		free(entry);
		return 0;
	}
	e = ENOMEM;
	if (!posix_spawn_file_actions_init(&fa)) {
		/* the other streams' ends are not this child's */
		for (struct child *c = children; c; c = c->next)
			if (posix_spawn_file_actions_addclose(&fa, fileno(c->file))) goto fail;
		if (!posix_spawn_file_actions_adddup2(&fa, p[1 - op], 1 - op)) {
			if (!(e = posix_spawn(&pid, "/bin/sh", &fa, 0, (char *[]){ "sh", "-c", (char *)cmd, 0 }, __environ))) {
				posix_spawn_file_actions_destroy(&fa);
				if (!strchr(mode, 'e')) fcntl(p[op], F_SETFD, 0);
				close(p[1 - op]);
				*entry = (struct child){ f, pid, children };
				children = entry;
				return f;
			}
		}
fail:
		posix_spawn_file_actions_destroy(&fa);
	}
	fclose(f);
	close(p[1 - op]);
	free(entry);
	errno = e;
	return 0;
}

int pclose(FILE *f) {
	struct child **link = &children, *entry;
	int status;
	pid_t pid;
	while (*link && (*link)->file != f) link = &(*link)->next;
	if (!(entry = *link)) { errno = ECHILD; return -1; }
	*link = entry->next;
	pid = entry->pid;
	free(entry);
	fclose(f);
	while (waitpid(pid, &status, 0) < 0)
		if (errno != EINTR) return -1;
	return status;
}
