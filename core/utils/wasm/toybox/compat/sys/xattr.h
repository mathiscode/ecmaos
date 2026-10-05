/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* No extended attributes here: reading finds none, setting fails. */
#ifndef ECMAOS_XATTR_H
#define ECMAOS_XATTR_H
#include <errno.h>
#include <stddef.h>
#include <sys/types.h>
static inline ssize_t getxattr(const char *p, const char *n, void *v, size_t s) { (void)p; (void)n; (void)v; (void)s; errno = ENODATA; return -1; }
static inline ssize_t lgetxattr(const char *p, const char *n, void *v, size_t s) { (void)p; (void)n; (void)v; (void)s; errno = ENODATA; return -1; }
static inline ssize_t fgetxattr(int f, const char *n, void *v, size_t s) { (void)f; (void)n; (void)v; (void)s; errno = ENODATA; return -1; }
static inline ssize_t listxattr(const char *p, char *l, size_t s) { (void)p; (void)l; (void)s; return 0; }
static inline ssize_t llistxattr(const char *p, char *l, size_t s) { (void)p; (void)l; (void)s; return 0; }
static inline ssize_t flistxattr(int f, char *l, size_t s) { (void)f; (void)l; (void)s; return 0; }
static inline int setxattr(const char *p, const char *n, const void *v, size_t s, int fl) { (void)p; (void)n; (void)v; (void)s; (void)fl; errno = ENOTSUP; return -1; }
static inline int lsetxattr(const char *p, const char *n, const void *v, size_t s, int fl) { (void)p; (void)n; (void)v; (void)s; (void)fl; errno = ENOTSUP; return -1; }
static inline int fsetxattr(int f, const char *n, const void *v, size_t s, int fl) { (void)f; (void)n; (void)v; (void)s; (void)fl; errno = ENOTSUP; return -1; }
#endif
