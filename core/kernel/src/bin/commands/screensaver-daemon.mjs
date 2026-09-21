/**
 * Real `execve`'d `screensaver-daemon`. Starting the idle-timeout daemon registers global DOM
 * activity listeners, which only the main thread can do, so this is one `screensaver_start` syscall.
 * Like the original it returns immediately: the listeners are the daemon, there is no process to keep.
 */

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const usage = `Usage: screensaver-daemon
Start the idle-timeout screensaver daemon: shows the configured screensaver
(the "screensaver" storage setting, default 'matrix') after a period of no
user activity (the "screensaver-timeout" storage setting in ms, default 60000).

  --help  display this help and exit

This registers global activity listeners and returns immediately -- there is
no per-process "daemon" to keep alive here, the same way starting it inline
during boot() never needed one either.`

const args = argv.slice(1)

if (args[0] === '--help' || args[0] === '-h') {
  write(2, new TextEncoder().encode(usage + '\n'))
  exit(0)
} else {
  // Quiet on success, like a real Unix daemon
  const status = await custom('screensaver_start')
  if (status !== 0) write(2, new TextEncoder().encode('screensaver-daemon: no such screensaver configured\n'))
  exit(status === 0 ? 0 : 1)
}
