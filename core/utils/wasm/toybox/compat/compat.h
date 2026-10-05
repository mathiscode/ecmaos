/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Force-included in every toybox file: the Linux pieces emscripten's libc lacks. */
#include <errno.h>
#include <unistd.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#define syscall(...) (errno = ENOSYS, -1L)
#define SYS_renameat2 0
