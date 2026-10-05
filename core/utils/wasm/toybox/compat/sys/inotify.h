/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* inotify does not exist here; toybox's tail -f and friends compile against it, so these always fail. */
#ifndef ECMAOS_INOTIFY_H
#define ECMAOS_INOTIFY_H
#include <errno.h>
#define IN_MODIFY 2
struct inotify_event { int wd; unsigned mask, cookie, len; char name[]; };
static inline int inotify_init(void) { errno = ENOSYS; return -1; }
static inline int inotify_add_watch(int fd, const char *path, unsigned mask) { (void)fd; (void)path; (void)mask; errno = ENOSYS; return -1; }
#endif
