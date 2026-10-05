/* SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* OpenBSD's strtonum(3): parse a decimal integer that must lie in [minval, maxval]; on failure return 0 and set
 * *errstrp to "invalid", "too small" or "too large". Written for ecmaOS; same contract. */
long long strtonum(const char *numstr, long long minval, long long maxval, const char **errstrp)
{
	static const char *const messages[] = { NULL, "invalid", "too small", "too large" };
	int failure = 0;
	long long value = 0;
	char *end;

	if (minval > maxval) {
		failure = 1;
	} else {
		errno = 0;
		value = strtoll(numstr, &end, 10);
		if (end == numstr || *end != '\0') failure = 1;
		else if ((errno == ERANGE && value == LLONG_MIN) || value < minval) failure = 2;
		else if ((errno == ERANGE && value == LLONG_MAX) || value > maxval) failure = 3;
	}
	if (errstrp != NULL) *errstrp = messages[failure];
	if (failure) {
		errno = failure == 1 ? EINVAL : ERANGE;
		return 0;
	}
	return value;
}

/* Batch mode (`mg -f`) wants a pty; the runtime has none a program can open this way, so it fails and mg carries on. */
struct winsize;
int openpty(int *master, int *slave, char *name, const void *termp, const struct winsize *winp)
{
	(void)master; (void)slave; (void)name; (void)termp; (void)winp;
	errno = ENOSYS;
	return -1;
}

int login_tty(int fd)
{
	(void)fd;
	errno = ENOSYS;
	return -1;
}

/* fparseln(3), reduced to what mg's tags loader needs: one logical line, without its newline, in a malloc'd buffer;
 * a backslash right before the newline joins the next physical line. NULL at end of file. Comments and escape
 * characters are not interpreted (mg asks for none), and *len and *lineno are filled in when given. */
char *fparseln(FILE *fp, size_t *len, size_t *lineno, const char delim[3], int flags)
{
	char *line = NULL, *physical = NULL;
	size_t used = 0, capacity = 0;
	ssize_t got;
	(void)delim; (void)flags;

	while ((got = getline(&physical, &capacity, fp)) != -1) {
		if (lineno) (*lineno)++;
		while (got > 0 && (physical[got - 1] == '\n' || physical[got - 1] == '\r')) got--;
		int joined = got > 0 && physical[got - 1] == '\\';
		if (joined) got--;
		char *grown = realloc(line, used + got + 1);
		if (!grown) { free(line); free(physical); return NULL; }
		line = grown;
		memcpy(line + used, physical, got);
		used += got;
		line[used] = '\0';
		if (!joined) break;
	}
	free(physical);
	if (len && line) *len = used;
	return line;
}
