/** Print the runlevel: `N 5` (N is the previous level, which init does not keep), or `unknown` when none is set. */

const { exit, write, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const readText = path => {
  try {
    const fd = open(path, O_RDONLY, 0)
    try {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      return new TextDecoder().decode(buffer.subarray(0, Math.max(0, n)))
    } finally { close(fd) }
  } catch { return undefined }
}

const asked = readText('/run/runlevel')?.trim()
const fallback = /^[^#:\n]*:([^:\n])[^:\n]*:initdefault:/m.exec(readText('/etc/inittab') ?? '')?.[1]
const level = asked ? asked[0] : fallback
write(1, new TextEncoder().encode(level ? `N ${level}\n` : 'unknown\n'))
exit(level ? 0 : 1)
