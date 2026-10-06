"""Runs a command on a pseudo-terminal for the tests: bytes on stdin go to the terminal, its output comes back on
stdout, and lines on fd 3 ("resize COLS ROWS") change its window size."""
import fcntl, os, pty, select, struct, sys, termios, signal

cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])

def winsize(c, r):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    try: os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError: pass

winsize(cols, rows)
fds = [master, 0, 3]
ctl = b''
while True:
    ready, _, _ = select.select(fds, [], [])
    if master in ready:
        try: data = os.read(master, 65536)
        except OSError: data = b''
        if not data: break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data: os.write(master, data)
        else: fds.remove(0)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data: fds.remove(3)
        ctl += data
        while b'\n' in ctl:
            line, ctl = ctl.split(b'\n', 1)
            parts = line.split()
            if parts and parts[0] == b'resize': winsize(int(parts[1]), int(parts[2]))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
