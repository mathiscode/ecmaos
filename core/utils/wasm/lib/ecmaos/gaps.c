/* SPDX-License-Identifier: MIT OR Apache-2.0
 * What Emscripten's libc leaves out that programs call and can do without. Extended attributes do not exist here:
 * each call says so (ENOTSUP), which is what Linux answers for a file system without them. */
#include <errno.h>
#include <sys/types.h>

static ssize_t unsupported(void) {
	errno = ENOTSUP;
	return -1;
}

ssize_t listxattr(const char *path, char *list, size_t size) { (void)path; (void)list; (void)size; return unsupported(); }
ssize_t llistxattr(const char *path, char *list, size_t size) { (void)path; (void)list; (void)size; return unsupported(); }
ssize_t flistxattr(int fd, char *list, size_t size) { (void)fd; (void)list; (void)size; return unsupported(); }
ssize_t getxattr(const char *path, const char *name, void *value, size_t size) { (void)path; (void)name; (void)value; (void)size; return unsupported(); }
ssize_t lgetxattr(const char *path, const char *name, void *value, size_t size) { (void)path; (void)name; (void)value; (void)size; return unsupported(); }
ssize_t fgetxattr(int fd, const char *name, void *value, size_t size) { (void)fd; (void)name; (void)value; (void)size; return unsupported(); }
int setxattr(const char *path, const char *name, const void *value, size_t size, int flags) { (void)path; (void)name; (void)value; (void)size; (void)flags; return unsupported(); }
int lsetxattr(const char *path, const char *name, const void *value, size_t size, int flags) { (void)path; (void)name; (void)value; (void)size; (void)flags; return unsupported(); }
int fsetxattr(int fd, const char *name, const void *value, size_t size, int flags) { (void)fd; (void)name; (void)value; (void)size; (void)flags; return unsupported(); }
int removexattr(const char *path, const char *name) { (void)path; (void)name; return unsupported(); }
int lremovexattr(const char *path, const char *name) { (void)path; (void)name; return unsupported(); }
int fremovexattr(int fd, const char *name) { (void)fd; (void)name; return unsupported(); }
