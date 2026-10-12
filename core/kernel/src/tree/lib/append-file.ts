/**
 * Appends to a file without `appendFile`, which on the root filesystem (`@zenfs/core` 2.7.6) writes each chunk at
 * offset 0 of the grown file. Reads the file and writes it back whole, with appends to one path queued. Costs a read
 * and a write per append, so not for hot loops. Delete it, and restore `appendFile`, when upstream fixes the offset.
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
