import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/bash` is GNU Bash built to WebAssembly (`core/utils-copyleft/wasm/bash/build.sh`) and run as a worker program.
 * It forks for a subshell, a command substitution, a pipeline, a process substitution, a coprocess and each command it
 * runs, so these are the fork support (Asyncify, `utils/wali/asyncify.sh`) under a program that depends on it, and
 * the places bash calls through a pointer that reach fork (the list in build.sh).
 */
describe('bash', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  const run = async (script: string) => {
    await kernel.filesystem.fs.writeFile('/tmp/bash.sh', script)
    const code = await kernel.shell.execute('bash /tmp/bash.sh > /tmp/bash.out 2> /tmp/bash.err')
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/bash.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/bash.err', 'utf8')
    }
  }

  it('is installed in /bin', async () => {
    expect((await kernel.filesystem.fs.stat('/bin/bash')).isFile()).toBe(true)
  })

  it('runs a command line given as an argument, and gives its status', async () => {
    const code = await kernel.shell.execute('bash -c "echo \\$((6*7)); exit 3" > /tmp/bash.out')
    expect(code).toBe(3)
    expect(await kernel.filesystem.fs.readFile('/tmp/bash.out', 'utf8')).toBe('42\n')
  }, 30000)

  it('has arrays, [[ ]], and the other things sh does not', async () => {
    expect(await run('a=(one two three)\nb=${a[@]:1}\n[[ $b == "two three" && ${#a[@]} -eq 3 ]] && echo ok\ndeclare -A m=([k]=v)\necho ${m[k]} ${BASH_VERSINFO[0]}\nmapfile -t l < <(printf "x\\ny\\n")\necho ${#l[@]}:${l[1]}\n'))
      .toEqual({ code: 0, out: 'ok\nv 5\n2:y\n', err: '' })
  }, 30000)

  it('forks for a subshell, a substitution, a pipeline and a process substitution', async () => {
    expect(await run('x=parent\n(x=child; echo "in $x")\ny=$(echo $x; x=lost)\necho "$y $x"\necho a b | tr a-z A-Z | cat\ncat <(echo ps)\n[ "$BASHPID" != "$$" ] && echo same || echo "$(echo $BASHPID)" > /dev/null\n( [ "$BASHPID" != "$$" ] && echo subshell )\n'))
      .toEqual({ code: 0, out: 'in child\nparent parent\nA B\nps\nsubshell\n', err: '' })
  }, 30000)

  it('runs jobs in the background, waits for them and gives their statuses', async () => {
    expect(await run('(exit 4) &\na=$!\n(exit 6) &\nb=$!\nwait $a; echo $?\nwait $b; echo $?\nfalse | true; echo ${PIPESTATUS[@]}\nset -o pipefail; false | true; echo $?\n'))
      .toEqual({ code: 0, out: '4\n6\n1 0\n1\n', err: '' })
  }, 30000)

  it('runs a trap, a function, and a coprocess', async () => {
    expect(await run('trap \'echo t\' EXIT\nf() { local v=$(echo f); echo $v; }\nf\ncoproc C { cat; }\necho hi >&${C[1]}\nread -u ${C[0]} line\necho $line\n'))
      .toEqual({ code: 0, out: 'f\nhi\nt\n', err: '' })
  }, 30000)
  // bash runs builtins, expansions and traps through pointers, and Asyncify is told which of those calls reach fork
  // (wasm/bash/build.sh); each of these is a place that runs a command from one
  it('forks under eval, source, command, builtin, a function and exec', async () => {
    expect(await run('eval \'echo e | tr e E\'\necho \'echo s | tr s S\' > /tmp/bash-src\nsource /tmp/bash-src\n. /tmp/bash-src\nf() { (echo f | tr f F); echo "$(echo g)"; }\nf\ncommand echo c | tr c C\nbuiltin eval \'echo b | tr b B\'\n(exec echo x)\nx=$(eval \'(echo n)\')\necho "$x"\n'))
      .toEqual({ code: 0, out: 'E\nS\nS\nF\ng\nC\nB\nx\nn\n', err: '' })
  }, 30000)

  it('forks under each expansion and assignment', async () => {
    expect(await run('a=$(echo 1) b=$(echo 2) eval \'echo $a$b\'\ndeclare -r d=$(echo d); export e=$(echo e); local_f() { local l=$(echo l); echo $l; }\necho $d $e; local_f\narr=($(echo p q) $(echo r)); echo ${#arr[@]}\necho ${u:-$(echo dflt)} $((`echo 3` + $(echo 4)))\nprintf -v pv "%s" "$(echo pv)"; echo $pv\ncase $(echo z) in z) echo case;; esac\nfor i in $(echo 1 2); do echo -n $i; done; echo\n[[ $(echo m) == m ]] && echo dbl\ncat <<< "$(echo here)"\nread -r rv < <(echo rd); echo $rv\n'))
      .toEqual({ code: 0, out: '12\nd e\nl\n3\ndflt 7\npv\ncase\n12\ndbl\nhere\nrd\n', err: '' })
  }, 30000)

  it('forks in a trap, in a DEBUG trap, a RETURN trap and an ERR trap, and for time', async () => {
    expect(await run('trap \'echo exit | tr e E\' EXIT\ntrap \'echo $(echo err)\' ERR\nfalse\nset -T\ntrap \'echo $(echo ret)\' RETURN\nf() { :; }; f\ntrap - RETURN\ntrap \'x=$(echo dbg)\' DEBUG\ny=1\ntrap - DEBUG\necho $x\ntime (echo timed) 2> /dev/null\ntrap \'echo $(echo usr)\' USR1; kill -USR1 $$; sleep 0.1\n'))
      .toEqual({ code: 0, out: 'err\nret\ndbg\ntimed\nusr\nExit\n', err: '' })
  }, 30000)

  // bash applies the redirections of a command in the child it forks for it, ahead of the exec, so the writer of
  // `< <(...)` is a child of the program that reads it
  it('runs a program that reads a process substitution made in its own, pre-exec process', async () => {
    expect(await run('cat < <(echo a)\nxargs -n1 echo < <(sleep 0.2; echo xa xb)\n'))
      .toEqual({ code: 0, out: 'a\nxa\nxb\n', err: '' })
  }, 30000)

  it('forks under a prompt, PROMPT_COMMAND, compgen and a coproc in a function', async () => {
    expect(await run('PS1=\'$(echo p)\\$ \'; echo "${PS1@P}"\nPROMPT_COMMAND=\'echo $(echo pc)\'; eval "$PROMPT_COMMAND"\ncompgen -W "$(echo aa ab b)" -- a | tr a-z A-Z\n(set -e; false; echo no); echo status=$?\n echo "$(echo "$(echo nest)")"\nxargs -n1 echo < <(echo xa xb)\n'))
      .toEqual({ code: 0, out: 'p$ \npc\nAA\nAB\nstatus=1\nnest\nxa\nxb\n', err: '' })
  }, 30000)
})
