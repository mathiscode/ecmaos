/**
 * What `su` and `sudo` share: who a user is (`/etc/passwd`, `/etc/group`), finding a program, asking for
 * a password, and running something as someone else and waiting for it.
 *
 * Both programs run with the setuid bit, so they act as root while `getuid()` still says who ran them.
 * They take the syscalls they need rather than reaching for the global, so the pieces can be tested.
 */

import { makeLoginIO } from './login-io.mjs'

const SIGINT = 2
const SIGQUIT = 3
const SIGCONT = 18
const SIGSTOP = 19
const SIGTSTP = 20

const ECHO = 0o10
const O_RDWR = 2
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function makePriv(sys, name) {
  const { write, writeAll, read, open, close, tcgetattr, tcsetattr, custom, spawn, waitpid, onSignal, stat, isDirectory, env, getuid, getpid } = sys
  const io = makeLoginIO(sys)

  const err = text => write(2, encoder.encode(`${name}: ${text}\n`))

  /** `/etc/passwd`: one `{ name, uid, gid, home, shell }` per line. */
  function users() {
    return (io.readFile('/etc/passwd') ?? '').split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => {
      const [username, , uid, gid, , home, shell] = line.split(':')
      return { name: username, uid: Number(uid), gid: Number(gid), home: home || '/', shell: shell || '' }
    })
  }

  /** `/etc/group`: one `{ name, gid, members }` per line. */
  function groups() {
    return (io.readFile('/etc/group') ?? '').split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => {
      const [groupName, , gid, members] = line.split(':')
      return { name: groupName, gid: Number(gid), members: (members ?? '').split(',').map(member => member.trim()).filter(Boolean) }
    })
  }

  const lookup = nameOrUid => users().find(user => typeof nameOrUid === 'number' ? user.uid === nameOrUid : user.name === nameOrUid)

  /** The user with the groups they belong to: their own, then every group that lists them. */
  function withGroups(user) {
    const all = groups()
    const member = all.filter(group => group.members.includes(user.name))
    const primary = all.find(group => group.gid === user.gid)
    const names = [primary?.name ?? user.name, ...member.map(group => group.name)]
    const gids = [user.gid, ...member.map(group => group.gid)]
    return { ...user, groups: member.map(group => group.gid).filter(gid => gid !== user.gid), groupNames: [...new Set(names)], gids: [...new Set(gids)] }
  }

  const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }

  /** A program by name, searching `PATH` as a shell does, or undefined. */
  function findProgram(command, pathVar = env.PATH ?? '/bin:/usr/bin') {
    if (command.includes('/')) return isFile(command) ? command : undefined
    for (const dir of pathVar.split(':')) {
      if (dir && isFile(`${dir}/${command}`)) return `${dir}/${command}`
    }
    return undefined
  }

  /** The shell to give `user`: the one in their passwd entry when it is a file, else ecmash. */
  const shellFor = user => user.shell.startsWith('/') && isFile(user.shell) ? user.shell : '/bin/ecmash'

  /** Neither program may be interrupted or stopped itself: the terminal's signals belong to what they run. */
  function ignoreTerminalSignals() {
    for (const signal of [SIGINT, SIGQUIT, SIGTSTP]) onSignal(signal, () => {})
  }

  /** One line from `fd`, without its newline; null at end of input. */
  function readLineFrom(fd) {
    const bytes = []
    const buffer = new Uint8Array(1)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) return bytes.length ? decoder.decode(new Uint8Array(bytes)) : null
      if (buffer[0] === 10) return decoder.decode(new Uint8Array(bytes))
      bytes.push(buffer[0])
    }
  }

  /**
   * Reads one hidden password: from stdin when it is a terminal, else from `/dev/tty`, always prompting on the
   * terminal. With `fromStdin` (`sudo -S`) it is the next line of stdin and the prompt goes to stderr. Returns null
   * at end of input or when interrupted.
   */
  function askPassword(prompt, fromStdin = false) {
    try {
      if (fromStdin) { write(2, encoder.encode(prompt)); return io.readLine() }
      const show = text => {
        let tty
        try { tty = open('/dev/tty', O_RDWR, 0) } catch { return io.out(text) }
        try { writeAll(tty, encoder.encode(text)) } finally { close(tty) }
      }
      let input = 0
      try { tcgetattr(0) } catch { input = open('/dev/tty', O_RDWR, 0) }
      const lflag = tcgetattr(input).lflag
      // echo goes off before the prompt is shown, so nothing typed the moment it appears is echoed
      tcsetattr(input, { lflag: lflag & ~ECHO })
      try {
        show(prompt)
        return readLineFrom(input)
      } finally {
        tcsetattr(input, { lflag })
        show('\n')
        if (input !== 0) close(input)
      }
    } catch (error) {
      if (io.isInterrupt(error)) { io.out('\n'); return null }
      throw error
    }
  }

  /** Whether `password` is `username`'s. */
  const authenticate = async (username, password) => await custom('users_authenticate', username, password) === 1

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Runs `program` as `user` and waits for it; resolves to its exit status (128 + n when a signal ended it).
   * `^Z` reaches this program, not the child, so it is passed on; once the child has stopped this program stops too
   * (as sudo does), which is what the shell sees as the job being stopped, and `fg`/`bg` resume both.
   */
  async function runAs(user, program, argv, { cwd, env: childEnv }) {
    let pid
    try {
      pid = await spawn(program, argv, { cwd, env: childEnv, credentials: { uid: user.uid, gid: user.gid, groups: user.groups } })
    } catch (error) {
      err(`${program}: ${error?.message ?? error}`)
      return 126
    }
    onSignal(SIGTSTP, () => { custom('proc_kill', pid, SIGTSTP).catch(() => {}) })
    for (;;) {
      let done
      try {
        done = await waitpid(pid, false, true)
      } catch (error) {
        if (`${error?.code} ${error?.message ?? error}`.includes('EINTR')) continue
        throw error
      }
      if (done.stopped) {
        // stop here too; when the shell continues this program, continue the child
        try { await custom('proc_kill', getpid(), SIGSTOP) } catch { /* cannot stop */ }
        // the terminal's signals (^C, ^Z) go to the child again, as before the stop
        try { await custom('proc_tcsetpgrp', pid) } catch { /* no terminal */ }
        try { await custom('proc_kill', pid, SIGCONT) } catch { /* gone */ }
        continue
      }
      return done.signal ? 128 + done.signal : done.code
    }
  }

  /**
   * The kernel must be able to tell who is asking; otherwise these programs refuse, rather than give root to anyone.
   */
  async function supported() {
    if (await custom('credentials_supported') === 1) return true
    err('cannot run programs as another user: the installed @zenfs/core does not support it')
    return false
  }

  return { ...io, err, users, groups, lookup, withGroups, findProgram, shellFor, ignoreTerminalSignals, askPassword, authenticate, pause, runAs, supported, getuid }
}
