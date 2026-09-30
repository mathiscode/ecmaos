/**
 * Append to a file without `appendFile`.
 *
 * On the root filesystem (@zenfs/core 2.7.6) `appendFile` writes each new chunk at offset 0 of the
 * file it has just grown, so a second append leaves the file's tail as NUL bytes and the first
 * record overwritten. Every caller here hit it: `>>`, `~/.history`, `/etc/shadow` and `kernel.log`.
 * This reads the file and writes it back whole, with appends to one path queued so that two callers
 * cannot both read the old content. The cost is a read and a write per append; nothing that uses it
 * appends in a hot loop. Delete it, and put `appendFile` back, when upstream fixes the offset.
 */

interface AppendFs {
  exists(path: string): Promise<boolean>
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf-8', mode?: number }): Promise<void>
}

const queues = new Map<string, Promise<unknown>>()

export function appendText(fs: AppendFs, path: string, data: string, options: { mode?: number } = {}): Promise<void> {
  const work = async () => {
    const before = (await fs.exists(path)) ? await fs.readFile(path, { encoding: 'utf-8' }) : ''
    await fs.writeFile(path, before + data, { encoding: 'utf-8', ...(options.mode !== undefined ? { mode: options.mode } : {}) })
  }
  const previous = queues.get(path) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.catch(() => {})
  queues.set(path, tail)
  void tail.then(() => { if (queues.get(path) === tail) queues.delete(path) })
  return next
}
