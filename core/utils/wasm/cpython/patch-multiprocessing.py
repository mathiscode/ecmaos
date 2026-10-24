#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Patches Modules/_multiprocessing (the directory is the argument), with two changes:
# - multiprocessing.h gets a format code for a pointer the size of an int: WALI's `long` is 64 bits and its pointers
#   32, so upstream finds none;
# - a SemLock is a pipe of tokens, not a POSIX semaphore. A POSIX semaphore shared by processes is an atomic word in
#   shared memory, and on ecmaOS a process's memory is its own: a shared mapping is copied to and from the file at calls
#   (see "shared file mappings" in core/kernel/src/bin/wali-host.mjs), so two processes can both take the one token. A
#   pipe is the kernel's: a token is a byte in it, acquire reads one, release writes one, and fork shares the
#   descriptors, which is how the fork start method shares a lock. The handle is a small structure of the two
#   descriptors, so a fork's copy of it is as good as the original. A lock opened by name (the spawn and forkserver
#   start methods) is not supported, nor is get_value (a pipe's size is not asked of ioctl). A value past 32768 starts with 32768 tokens.
import re
import sys

directory = sys.argv[1]
header_path = directory + '/multiprocessing.h'
header = open(header_path).read()

old_type = '     typedef sem_t *SEM_HANDLE;'
assert header.count(old_type) == 1, 'multiprocessing.h changed: no typedef of SEM_HANDLE'
header = header.replace(old_type, '     typedef struct { int r, w; } ps_t;\n     typedef ps_t *SEM_HANDLE;')

old_format = '#else\n#  error "can\'t find format code for unsigned integer of same size as void*"'
assert header.count(old_format) == 1, 'multiprocessing.h changed: no error for a pointer of no integer size'
header = header.replace(old_format, '#elif SIZEOF_VOID_P == SIZEOF_INT\n#  define F_POINTER "I"\n#  define T_POINTER T_UINT\n' + old_format)
open(header_path, 'w').write(header)

path = directory + '/semaphore.c'
text = open(path).read()

shim = r'''
/* ecmaOS: a semaphore is a pipe holding a byte for each token (see build.sh) */
#include <poll.h>
#include <sys/ioctl.h>
#include <time.h>

static ps_t *
ps_create(unsigned value)
{
    int fds[2];
    /* a queue's bound is the largest int; its semaphore holds no more tokens than a pipe does */
    if (value > 32768)
        value = 32768;
    if (pipe2(fds, O_CLOEXEC | O_NONBLOCK) < 0)
        return NULL;
    for (unsigned i = 0; i < value; i++) {
        if (write(fds[1], "x", 1) != 1) {
            close(fds[0]);
            close(fds[1]);
            return NULL;
        }
    }
    ps_t *sem = malloc(sizeof(ps_t));
    if (sem == NULL) {
        close(fds[0]);
        close(fds[1]);
        errno = ENOMEM;
        return NULL;
    }
    sem->r = fds[0];
    sem->w = fds[1];
    return sem;
}

static int
ps_trywait(ps_t *sem)
{
    char token;
    for (;;) {
        ssize_t n = read(sem->r, &token, 1);
        if (n == 1)
            return 0;
        if (n < 0 && errno == EINTR)
            continue;
        if (n == 0)
            errno = EAGAIN;
        return -1;
    }
}

static int
ps_wait(ps_t *sem)
{
    for (;;) {
        if (ps_trywait(sem) == 0)
            return 0;
        if (errno != EAGAIN)
            return -1;
        struct pollfd wait = { .fd = sem->r, .events = POLLIN };
        if (poll(&wait, 1, -1) < 0)
            return -1;
    }
}

static int
ps_timedwait(ps_t *sem, const struct timespec *deadline)
{
    for (;;) {
        if (ps_trywait(sem) == 0)
            return 0;
        if (errno != EAGAIN)
            return -1;
        struct timespec now;
        clock_gettime(CLOCK_REALTIME, &now);
        long long ms = ((long long)deadline->tv_sec - now.tv_sec) * 1000
            + ((long long)deadline->tv_nsec - now.tv_nsec + 999999) / 1000000;
        if (ms <= 0) {
            errno = ETIMEDOUT;
            return -1;
        }
        struct pollfd wait = { .fd = sem->r, .events = POLLIN };
        if (poll(&wait, 1, ms > 0x7fffffff ? 0x7fffffff : (int)ms) < 0)
            return -1;
    }
}

static int
ps_post(ps_t *sem)
{
    return write(sem->w, "x", 1) == 1 ? 0 : -1;
}

static int
ps_getvalue(ps_t *sem, int *value)
{
    int pending = 0;
    if (ioctl(sem->r, FIONREAD, &pending) < 0)
        return -1;
    *value = pending;
    return 0;
}

static int
ps_close(ps_t *sem)
{
    close(sem->r);
    close(sem->w);
    free(sem);
    return 0;
}

static ps_t *
ps_open(const char *name, int flags)
{
    errno = ENOSYS;
    return NULL;
}
'''

# the Unix definitions: the creation, close, value and unlink macros use the pipe
old = '''#define SEM_CREATE(name, val, max) sem_open(name, O_CREAT | O_EXCL, 0600, val)
#define SEM_CLOSE(sem) sem_close(sem)
#define SEM_GETVALUE(sem, pval) sem_getvalue(sem, pval)
#define SEM_UNLINK(name) sem_unlink(name)
'''
assert text.count(old) == 1, 'semaphore.c changed: the Unix SEM_* definitions are not where they were'
text = text.replace(old, shim + '''
#define SEM_CREATE(name, val, max) ps_create(val)
#define SEM_CLOSE(sem) ps_close(sem)
#define SEM_GETVALUE(sem, pval) ps_getvalue(sem, pval)
#define SEM_UNLINK(name) 0
#undef SEM_FAILED
#define SEM_FAILED ((ps_t *)0)
''')

# every other use of the POSIX calls and the type, in the code after the definitions
head, sep, tail = text.partition('#define SEM_UNLINK(name) 0\n#undef SEM_FAILED\n#define SEM_FAILED ((ps_t *)0)\n')
for name in ('trywait', 'wait', 'timedwait', 'post', 'getvalue'):
    tail = re.sub(r'\bsem_%s\(' % name, 'ps_%s(' % name, tail)
tail = re.sub(r'\bsem_open\(', 'ps_open(', tail)
tail = tail.replace('sem_t', 'ps_t')
# the fallbacks for a C library without sem_timedwait / sem_unlink and the Apple SEM_FAILED are for the POSIX calls
text = head + sep + tail
assert 'sem_open(name, 0)' not in text and 'sem_trywait(self' not in text, 'semaphore.c: a POSIX semaphore call is left'
open(path, 'w').write(text)
