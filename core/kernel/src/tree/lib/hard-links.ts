/**
 * Removing one name of a file that has others. The store-backed filesystems (the IndexedDB root, `/tmp`, the Node host's
 * SQLite root) keep an index from each path to its inode; when the name removed is not the file's last, they take it out
 * of the directory but leave it in the index, so `stat` and `open` of the removed name still find the file. This takes
 * the name out of the index as well, after the removal has been committed.
 */

import { StoreFS } from '@zenfs/core'

interface PathIndex { _ids: Map<string, number>, _paths: Map<number, Set<string>> }

/** Forgets `path` when the removal left it pointing at the inode it had */
function forget(fs: PathIndex, path: string, ino: number | undefined): void {
  if (ino === undefined || fs._ids.get(path) !== ino) return
  fs._ids.delete(path)
  fs._paths.get(ino)?.delete(path)
}

let installed = false
export function installHardLinkRemoval(): void {
  if (installed) return
  installed = true
  const proto = StoreFS.prototype as unknown as PathIndex & {
    removeSync(path: string, isDir: boolean): void
    remove(path: string, isDir: boolean): Promise<void>
  }
  const removeSync = proto.removeSync
  proto.removeSync = function (this: PathIndex, path: string, isDir: boolean) {
    const ino = this._ids.get(path)
    removeSync.call(this, path, isDir)
    forget(this, path, ino)
  }
  const remove = proto.remove
  proto.remove = async function (this: PathIndex, path: string, isDir: boolean) {
    const ino = this._ids.get(path)
    await remove.call(this, path, isDir)
    forget(this, path, ino)
  }
}
