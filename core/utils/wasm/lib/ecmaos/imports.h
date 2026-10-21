/* SPDX-License-Identifier: MIT OR Apache-2.0
 * The calls libecmaos makes to the host that runs Emscripten programs (core/kernel/src/bin/wasi-preview1.mjs). Each
 * returns what the kernel answered: a negative value is -errno in Emscripten's numbering. */
#ifndef ECMAOS_IMPORTS_H
#define ECMAOS_IMPORTS_H
#include <signal.h>
#include <sys/types.h>

#define ECMAOS_IMPORT(name) __attribute__((__import_module__("env"), __import_name__(#name)))

/* One posix_spawn file action, as the host reads it: 24 bytes, the same as for WALI's musl */
struct ecmaos_spawn_op {
	int cmd, fd, srcfd, oflag, mode;
	const char *path;
};

/* posix_spawn: the whole request, the file actions in the order they were added (the same call WALI programs make) */
ECMAOS_IMPORT(__ecmaos_spawn) long __ecmaos_spawn(const char *, char *const *, char *const *, const struct ecmaos_spawn_op *,
	int, int, int, const sigset_t *, const sigset_t *);
ECMAOS_IMPORT(__ecmaos_execve) int __ecmaos_execve(const char *, char *const *, char *const *);
ECMAOS_IMPORT(__ecmaos_wait4) pid_t __ecmaos_wait4(pid_t, int *, int);
/* kill(2) on the kernel's processes; the host carries out a default action this process sends itself */
ECMAOS_IMPORT(__ecmaos_kill) int __ecmaos_kill(pid_t, int);
/* the ignored signals (0) or the mask (1) the process was started or exec'ed with, as a sigset of signals 1 to 31 */
ECMAOS_IMPORT(__ecmaos_sigstate) int __ecmaos_sigstate(int);
/* what a child or the next image starts with, in the same form */
ECMAOS_IMPORT(__ecmaos_set_sigstate) int __ecmaos_set_sigstate(int, int);
/* sleeps until the time is up or a handler runs; what was left is written to the timespec */
ECMAOS_IMPORT(__ecmaos_sleep) int __ecmaos_sleep(double, struct timespec *);
/* waits until a handler has run, then answers -EINTR */
ECMAOS_IMPORT(__ecmaos_pause) int __ecmaos_pause(void);

/* the process calls the host already answers under Emscripten's names */
ECMAOS_IMPORT(__syscall_getpid) pid_t __ecmaos_getpid(void);
ECMAOS_IMPORT(__syscall_getppid) pid_t __ecmaos_getppid(void);
ECMAOS_IMPORT(__syscall_getpgid) pid_t __ecmaos_getpgid(pid_t);
ECMAOS_IMPORT(__syscall_setpgid) int __ecmaos_setpgid(pid_t, pid_t);
ECMAOS_IMPORT(__syscall_getsid) pid_t __ecmaos_getsid(pid_t);
ECMAOS_IMPORT(__syscall_setsid) pid_t __ecmaos_setsid(void);

/* signal.c: tells the kernel the ignored signals and the mask, for a child or an exec to start with */
void __ecmaos_publish_signals(void);

#endif
