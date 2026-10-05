/* SPDX-License-Identifier: MIT OR Apache-2.0
 * Linked into Vim. New code added to Vim may use any license that does not restrict others from making their own changes to the official Vim (Vim license, II.2.c); this one is permissive. */
/* What Vim needs that musl does not have.
 * - termcap: tgetent always fails, so Vim uses its builtin terminal entries; tgoto expands the termcap
 *   % codes those entries use (%d %2 %3 %. %+c %i %r %%).
 * - extended attributes: do not exist here; Vim only uses them to copy attributes on write. */
#include <stdio.h>
char PC, *BC, *UP; short ospeed;
int tgetent(char *b, const char *n){ (void)b; (void)n; return 0; }
int tgetflag(char *id){ (void)id; return 0; }
int tgetnum(char *id){ (void)id; return -1; }
char *tgetstr(char *id, char **a){ (void)id; (void)a; return 0; }
char *tgoto(const char *cm, int col, int row){
  static char out[64]; char *o = out; int args[2] = { row, col }, ai = 0;
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
  *o = 0; return out;
}
int tputs(const char *s, int n, int (*f)(int)){ (void)n; while(*s) f(*s++); return 0; }

#include <errno.h>
#include <sys/types.h>
ssize_t listxattr(const char *p, char *l, size_t s){ (void)p; (void)l; (void)s; errno = ENOTSUP; return -1; }
ssize_t getxattr(const char *p, const char *n, void *v, size_t s){ (void)p; (void)n; (void)v; (void)s; errno = ENOTSUP; return -1; }
int setxattr(const char *p, const char *n, const void *v, size_t s, int f){ (void)p; (void)n; (void)v; (void)s; (void)f; errno = ENOTSUP; return -1; }

/* Signals: the host (src/bin/wasi-preview1.mjs) calls this when the kernel raises one, and it runs the
 * handler the program set with signal()/sigaction(), the way a real kernel does on the way back to user
 * space. Returns 1 when the program handled or ignored the signal, 0 when the default action applies. */
#include <signal.h>
int ecmaos_signal(int sig) {
  struct sigaction old;
  if (sigaction(sig, 0, &old) != 0) return 0;
  if (old.sa_handler == SIG_IGN) return 1;
  if (old.sa_handler == SIG_DFL) return 0;
  raise(sig);
  return 1;
}
