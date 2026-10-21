/* SPDX-License-Identifier: MIT OR Apache-2.0
 * The libc-test subset as one program: every test's main is linked in under a name of its own (build.sh renames them
 * and writes tests.h, the table of them), and the program is the test its name says (`functional.argv` is
 * src/functional/argv.c), so a test that runs argv[0] again runs itself. Run as `libc-test run DIR NAME...`, it links
 * each name in DIR to itself, starts it with posix_spawn, gives it ten seconds (SIGKILL after that) and prints one line
 * per test, `PASS name` or `FAIL name: why`, with what a failing test wrote indented under it, as libc-test's own
 * runtest reports. With no name it runs them all. A test that is a program of its own (build.sh says which) is run
 * from DIR as it is. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

struct test {
	const char *name;
	int (*run)(int, char **);
};

#include "tests.h"

#define COUNT (sizeof tests / sizeof *tests)
#define TIMEOUT_MS 10000

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

/* Runs one test as DIR/NAME, collecting what it writes; returns its wait status, or -1 when it was killed for time */
static int run(const char *self, const char *dir, const char *name, char *out, size_t room) {
	char path[512];
	int ends[2], status;
	size_t got = 0;
	pid_t pid;
	posix_spawn_file_actions_t actions;

	snprintf(path, sizeof path, "%s/%s", dir, name);
	/* a test that is a program of its own is already there; the others are this program under their name */
	struct stat st;
	int own = !lstat(path, &st) && S_ISREG(st.st_mode);
	if (!own && (unlink(path), symlink(self, path))) {
		snprintf(out, room, "symlink: %s\n", strerror(errno));
		return -2;
	}
	if (pipe2(ends, O_CLOEXEC)) return -2;
	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_adddup2(&actions, ends[1], 1);
	posix_spawn_file_actions_adddup2(&actions, ends[1], 2);
	int error = posix_spawn(&pid, path, &actions, 0, (char *[]){ path, 0 }, environ);
	posix_spawn_file_actions_destroy(&actions);
	close(ends[1]);
	if (error) {
		close(ends[0]);
		snprintf(out, room, "posix_spawn: %s\n", strerror(error));
		return -2;
	}
	long long deadline = now_ms() + TIMEOUT_MS;
	int timed_out = 0, open_end = 1;
	for (;;) {
		if (open_end) {
			struct pollfd p = { .fd = ends[0], .events = POLLIN };
			int left = (int)(deadline - now_ms());
			if (left < 0) left = 0;
			if (poll(&p, 1, left > 100 ? 100 : left) > 0) {
				char chunk[512];
				ssize_t n = read(ends[0], chunk, sizeof chunk);
				if (n <= 0) open_end = 0;
				else if (got < room - 1) {
					size_t take = (size_t)n < room - 1 - got ? (size_t)n : room - 1 - got;
					memcpy(out + got, chunk, take);
					got += take;
				}
			}
		} else {
			usleep(10000);
		}
		pid_t done = waitpid(pid, &status, WNOHANG);
		if (done == pid && !open_end) break;
		if (done == pid) {
			/* drain what is left once it has ended */
			char chunk[512];
			ssize_t n;
			fcntl(ends[0], F_SETFL, O_NONBLOCK);
			while ((n = read(ends[0], chunk, sizeof chunk)) > 0 && got < room - 1) {
				size_t take = (size_t)n < room - 1 - got ? (size_t)n : room - 1 - got;
				memcpy(out + got, chunk, take);
				got += take;
			}
			break;
		}
		if (now_ms() > deadline) {
			kill(pid, SIGKILL);
			waitpid(pid, &status, 0);
			timed_out = 1;
			break;
		}
	}
	close(ends[0]);
	if (!own) unlink(path);
	out[got] = 0;
	return timed_out ? -1 : status;
}

static int report(const char *self, const char *dir, const char *name) {
	static char out[4096];
	int status = run(self, dir, name, out, sizeof out);
	if (status >= 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0) {
		printf("PASS %s\n", name);
		return 0;
	}
	if (status == -1) printf("FAIL %s: timed out\n", name);
	else if (status == -2) printf("FAIL %s: not started\n", name);
	else if (WIFSIGNALED(status)) printf("FAIL %s: killed by signal %d\n", name, WTERMSIG(status));
	else printf("FAIL %s: exit %d\n", name, WEXITSTATUS(status));
	for (char *line = strtok(out, "\n"); line; line = strtok(0, "\n")) printf("  %s\n", line);
	return 1;
}

int main(int argc, char **argv) {
	const char *base = strrchr(argv[0], '/');
	base = base ? base + 1 : argv[0];
	for (size_t i = 0; i < COUNT; i++)
		if (!strcmp(base, tests[i].name)) return tests[i].run(argc, argv);

	if (argc < 3 || strcmp(argv[1], "run")) {
		fprintf(stderr, "usage: %s run DIR [NAME]...\n", argv[0]);
		return 2;
	}
	setvbuf(stdout, 0, _IONBF, 0);
	char self[512];
	if (!realpath(argv[0], self)) snprintf(self, sizeof self, "%s", argv[0]);
	int failed = 0;
	if (argc == 3) {
		for (size_t i = 0; i < COUNT; i++) failed += report(self, argv[2], tests[i].name);
	} else {
		for (int i = 3; i < argc; i++) failed += report(self, argv[2], argv[i]);
	}
	return failed ? 1 : 0;
}
