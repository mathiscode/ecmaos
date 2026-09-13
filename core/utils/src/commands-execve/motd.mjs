/**
 * Real `execve`'d `motd` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/motd.ts`) per `feat/1.0.0-execve-commands`. `kernel.filesystem.fs`
 * reads are replaced by real `open`/`read`/`close`/`stat` syscalls, same as every other migrated
 * coreutil.
 */

const { argv, exit, writeAll, open, read, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: motd
Print the message of the day (/etc/motd), if one exists.

  --help  display this help and exit`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let motd
  try {
    motd = readWholeFile('/etc/motd')
  } catch {
    return 0
  }

  if (motd.length > 0) writeAll(1, motd)
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`motd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
