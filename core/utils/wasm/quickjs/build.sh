#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/qjs.wasm: the QuickJS-ng JavaScript interpreter (`qjs`: script runner and REPL) for ecmaOS, on
# WALI's musl (`utils/check-wali.sh`), run by /bin/wali. The result is committed, so only run this to change it.
# Built with the std and os modules (QJS_BUILD_LIBC); os.Worker runs each worker on a thread of its own. The source is
# unmodified except for two things. os.exec: there is no fork, so it starts the program with posix_spawn, its
# descriptors and directory set up by file actions as the forked child set them up; uid, gid and groups, which the
# child would set before its exec, are refused with an error, and the child keeps the descriptors above 2 that are not
# close-on-exec. And a worker's thread function returns void *: pthread_create calls it through a pointer of that
# type, and a call through a pointer of another type, harmless on a CPU, traps in wasm.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=0.17.0
SHA256=559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/qjs.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o quickjs.tar.gz "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  quickjs.tar.gz" | sha256sum -c -
tar xzf quickjs.tar.gz
cd "quickjs-$VERSION"

python3 - <<'PY'
p = 'quickjs-libc.c'
s = open(p).read()
def patch(old, new):
    global s
    assert s.count(old) == 1, 'quickjs source changed: %r not found once' % old[:60]
    s = s.replace(old, new, 1)
patch('#include <sys/wait.h>\n', '#include <sys/wait.h>\n#include <spawn.h>\n')
# js_thread_create calls the start function through a pointer of pthread's type, which wasm checks
patch('static void worker_func(void *opaque)\n', 'static void *worker_func(void *opaque)\n')
patch('    JS_FreeContext(ctx);\n    JS_FreeRuntime(rt);\n}\n\nstatic JSValue js_worker_ctor_internal',
      '    JS_FreeContext(ctx);\n    JS_FreeRuntime(rt);\n    return NULL;\n}\n\nstatic JSValue js_worker_ctor_internal')
patch('js_thread_create(&thr, worker_func, args,', 'js_thread_create(&thr, (void (*)(void *))worker_func, args,')
start = s.index('    pid = fork();\n')
end = s.index('    /* parent */\n', start)
child = s[start:end]
for line in ('dup2(std_fds[i], i)', 'js_os_exec_closefrom(3)', 'chdir(cwd)', 'setgroups(ngroups, groups)',
             'setuid(uid)', 'setgid(gid)', 'my_execvpe(file, (char **)exec_argv, envp)'):
    assert line in child, 'quickjs source changed: the forked child no longer does %s' % line
s = s[:start] + '''    if (ngroups != -1 || uid != -1 || gid != -1) {
        JS_ThrowTypeError(ctx, "uid, gid and groups are not supported");
        goto exception;
    }
    {
        posix_spawn_file_actions_t fa;
        int err;
        if (posix_spawn_file_actions_init(&fa) != 0) {
            JS_ThrowTypeError(ctx, "fork error");
            goto exception;
        }
        for(i = 0; i < 3; i++) {
            if (std_fds[i] != i)
                posix_spawn_file_actions_adddup2(&fa, std_fds[i], i);
        }
        if (cwd)
            posix_spawn_file_actions_addchdir_np(&fa, cwd);
        const char *path = file ? file : exec_argv[0];
        if (use_path)
            err = posix_spawnp(&pid, path, &fa, NULL, (char **)exec_argv, envp);
        else
            err = posix_spawn(&pid, path, &fa, NULL, (char **)exec_argv, envp);
        posix_spawn_file_actions_destroy(&fa);
        if (err != 0) {
            /* what the forked child's failed exec would have exited with */
            if (!block_flag) {
                JS_ThrowTypeError(ctx, "exec error: %s", strerror(err));
                goto exception;
            }
            ret = 127;
            ret_val = JS_NewInt32(ctx, ret);
            goto done;
        }
    }
''' + s[end:]
open(p, 'w').write(s)
PY

"$WALI_CC" -O2 -D_GNU_SOURCE -DQJS_BUILD_LIBC \
  dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c gen/repl.c gen/standalone.c qjs.c -o qjs.wasm -lm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp qjs.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
