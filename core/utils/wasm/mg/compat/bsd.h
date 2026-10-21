/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* The few libbsd functions mg uses that musl lacks; defined in bsd.c. Force-included into every file. */
#ifndef ECMAOS_BSD_H
#define ECMAOS_BSD_H
#include <stdlib.h>
#include <string.h>
#include <sys/queue.h>

/* glibc's <sys/queue.h> (copied here) predates these BSD macros: iteration that survives removing the current element. */
#ifndef SLIST_FOREACH_SAFE
#define SLIST_FOREACH_SAFE(var, head, field, tvar) \
	for ((var) = SLIST_FIRST(head); (var) && ((tvar) = SLIST_NEXT(var, field), 1); (var) = (tvar))
#endif
#ifndef LIST_FOREACH_SAFE
#define LIST_FOREACH_SAFE(var, head, field, tvar) \
	for ((var) = LIST_FIRST(head); (var) && ((tvar) = LIST_NEXT(var, field), 1); (var) = (tvar))
#endif
#ifndef TAILQ_FOREACH_SAFE
#define TAILQ_FOREACH_SAFE(var, head, field, tvar) \
	for ((var) = TAILQ_FIRST(head); (var) && ((tvar) = TAILQ_NEXT(var, field), 1); (var) = (tvar))
#endif
#ifndef TAILQ_FOREACH_REVERSE_SAFE
#define TAILQ_FOREACH_REVERSE_SAFE(var, head, headname, field, tvar) \
	for ((var) = TAILQ_LAST(head, headname); (var) && ((tvar) = TAILQ_PREV(var, headname, field), 1); (var) = (tvar))
#endif
/* batch mode's pty: musl's own */
#include <pty.h>
#include <utmp.h>
void *recallocarray(void *, size_t, size_t, size_t);
long long strtonum(const char *numstr, long long minval, long long maxval, const char **errstrp);
#endif
