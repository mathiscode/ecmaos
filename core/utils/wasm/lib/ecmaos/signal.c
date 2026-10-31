/* SPDX-License-Identifier: MIT OR Apache-2.0
 * Signals for Emscripten programs, as Linux has them. Emscripten keeps dispositions and the mask in the program and
 * only ever raises a signal the program sends itself; here the kernel's signals reach the handlers too. The host
 * (core/kernel/src/bin/wasip1.mjs) asks for each one with ecmaos_signal as a call into it returns, the way a
 * kernel runs a handler on the way back to user space, and answers the call it interrupted by what happened: resumed
 * when no handler ran, restarted after one with SA_RESTART, EINTR after any other. A default action that ends the
 * program is the kernel's, so a parent sees the child killed by the signal; one that stops it stops it.
 * Sleeping and waiting go to the kernel instead of spinning, so a signal ends them, and the ignored signals and the
 * mask carry into a child and across an exec. */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <time.h>
#include <unistd.h>
#include "imports.h"

/* Emscripten's (system/lib/libc/pthread_sigmask.c): the signals held back by the mask, raised as it unblocks them */
extern _Thread_local sigset_t __sig_pending;
bool __sig_is_blocked(int sig);
/* calls a handler from the host, which tolerates a handler declared with another signature */
void __call_sighandler(sighandler_t handler, int sig);

/* handlers that have run, so pause and sigsuspend know when to return */
static volatile unsigned ran;

static bool ignored_by_default(int sig) {
	return sig == SIGCHLD || sig == SIGCONT || sig == SIGURG || sig == SIGWINCH;
}

/* Runs a handler with its signal (unless SA_NODEFER) and its sa_mask blocked, as Linux does */
static void run(int sig, const struct sigaction *sa) {
	sigset_t during = sa->sa_mask, old;
	if (!(sa->sa_flags & SA_NODEFER)) sigaddset(&during, sig);
	if (sa->sa_flags & SA_RESETHAND) signal(sig, SIG_DFL);
	sigprocmask(SIG_BLOCK, &during, &old);
	ran++;
	if (sa->sa_flags & SA_SIGINFO) {
		siginfo_t info = { .si_signo = sig };
		sa->sa_sigaction(sig, &info, 0);
	} else {
		__call_sighandler(sa->sa_handler, sig);
	}
	sigprocmask(SIG_SETMASK, &old, 0);
}

/* What the host is told about a signal it delivers */
enum { DEFAULT_ACTION, NOTHING_RAN, RESTART, INTERRUPT };

__attribute__((export_name("ecmaos_signal"))) int ecmaos_signal(int sig) {
	struct sigaction sa;
	if (sig <= 0 || sig >= _NSIG) return NOTHING_RAN;
	if (__sig_is_blocked(sig)) {
		sigaddset(&__sig_pending, sig);
		return NOTHING_RAN;
	}
	sigaction(sig, 0, &sa);
	if (sa.sa_handler == SIG_IGN) return NOTHING_RAN;
	if (sa.sa_handler == SIG_DFL) return ignored_by_default(sig) ? NOTHING_RAN : DEFAULT_ACTION;
	run(sig, &sa);
	return sa.sa_flags & SA_RESTART ? RESTART : INTERRUPT;
}

int raise(int sig) {
	struct sigaction sa;
	if (sig <= 0 || sig >= _NSIG) {
		errno = EINVAL;
		return -1;
	}
	if (__sig_is_blocked(sig)) {
		sigaddset(&__sig_pending, sig);
		return 0;
	}
	sigaction(sig, 0, &sa);
	if (sa.sa_handler == SIG_IGN) return 0;
	if (sa.sa_handler == SIG_DFL) {
		if (ignored_by_default(sig)) return 0;
		/* the kernel ends or stops the process */
		int value = __ecmaos_kill(getpid(), sig);
		if (value < 0) {
			errno = -value;
			return -1;
		}
		return 0;
	}
	run(sig, &sa);
	return 0;
}

/* pause and sigsuspend wait in the kernel until a handler has run */
static int wait_for_handler(unsigned before) {
	while (ran == before) __ecmaos_pause();
	errno = EINTR;
	return -1;
}

int pause(void) {
	return wait_for_handler(ran);
}

int sigsuspend(const sigset_t *mask) {
	sigset_t old;
	unsigned before = ran;
	/* a signal the new mask lets through that was already pending runs now */
	sigprocmask(SIG_SETMASK, mask, &old);
	wait_for_handler(before);
	sigprocmask(SIG_SETMASK, &old, 0);
	return -1;
}

/* Every sleep (nanosleep, usleep, sleep, thrd_sleep) ends up here */
int __clock_nanosleep(clockid_t clk, int flags, const struct timespec *req, struct timespec *rem) {
	if (clk == CLOCK_THREAD_CPUTIME_ID) return EINVAL;
	if (!req || req->tv_nsec < 0 || req->tv_nsec > 999999999L || req->tv_sec < 0) return EINVAL;
	double ms = req->tv_sec * 1000.0 + req->tv_nsec / 1e6;
	if (flags & TIMER_ABSTIME) {
		struct timespec now;
		clock_gettime(clk, &now);
		ms -= now.tv_sec * 1000.0 + now.tv_nsec / 1e6;
		if (ms <= 0) return 0;
		rem = 0;
	}
	int value = __ecmaos_sleep(ms, rem);
	return value < 0 ? -value : 0;
}

int clock_nanosleep(clockid_t clk, int flags, const struct timespec *req, struct timespec *rem) {
	return __clock_nanosleep(clk, flags, req, rem);
}

void __ecmaos_publish_signals(void) {
	struct sigaction sa;
	sigset_t mask;
	int ignored = 0;
	for (int sig = 1; sig < 32; sig++)
		if (!sigaction(sig, 0, &sa) && sa.sa_handler == SIG_IGN) ignored |= 1u << (sig - 1);
	sigprocmask(SIG_BLOCK, 0, &mask);
	__ecmaos_set_sigstate(ignored, ((unsigned *)&mask)[0] & 0x7fffffff);
}

/* What the process was started or exec'ed with: its ignored signals and its mask */
__attribute__((constructor)) static void inherit(void) {
	int ignored = __ecmaos_sigstate(0), blocked = __ecmaos_sigstate(1);
	if (ignored > 0)
		for (int sig = 1; sig < 32; sig++)
			if (ignored & (1u << (sig - 1))) signal(sig, SIG_IGN);
	if (blocked > 0) {
		sigset_t set;
		sigemptyset(&set);
		((unsigned *)&set)[0] = blocked;
		sigprocmask(SIG_SETMASK, &set, 0);
	}
}
