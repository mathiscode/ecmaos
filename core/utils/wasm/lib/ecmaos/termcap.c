/* SPDX-License-Identifier: MIT OR Apache-2.0
 * A termcap with no terminal database, for a program that can draw without one (libecmaos-termcap.a, linked only by
 * the programs that ask for it: Vim). tgetent never finds an entry, so Vim uses its builtin terminal entries; tgoto
 * expands the termcap % codes those entries use (%d %2 %3 %. %+c %i %r %%). */
#include <stdio.h>

char PC, *BC, *UP;
short ospeed;

int tgetent(char *buffer, const char *name) { (void)buffer; (void)name; return 0; }
int tgetflag(char *id) { (void)id; return 0; }
int tgetnum(char *id) { (void)id; return -1; }
char *tgetstr(char *id, char **area) { (void)id; (void)area; return 0; }

char *tgoto(const char *cm, int col, int row) {
	static char out[64];
	char *o = out;
	int args[2] = { row, col }, ai = 0;
	while (*cm && o < out + sizeof out - 12) {
		if (*cm != '%') { *o++ = *cm++; continue; }
		cm++;
		switch (*cm++) {
		case 'i': args[0]++; args[1]++; break;
		case 'r': { int t = args[0]; args[0] = args[1]; args[1] = t; break; }
		case 'd': o += sprintf(o, "%d", args[ai++]); break;
		case '2': o += sprintf(o, "%02d", args[ai++]); break;
		case '3': o += sprintf(o, "%03d", args[ai++]); break;
		case '.': *o++ = (char)args[ai++]; break;
		case '+': *o++ = (char)(args[ai++] + *cm++); break;
		case '%': *o++ = '%'; break;
		}
	}
	*o = 0;
	return out;
}

int tputs(const char *s, int count, int (*put)(int)) {
	(void)count;
	while (*s) put(*s++);
	return 0;
}
