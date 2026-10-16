import type { ProcessEntryParams } from '@ecmaos/types'

import { Desktop } from './desktop.js'

/**
 * `startx` / `desktop`: starts the desktop for the user who ran it. It takes over the page like a virtual console and
 * lasts until Exit or Ctrl+Alt+F1 to F8; the process lives as long as the desktop does.
 */
const main = async (params: ProcessEntryParams) => {
  const { instance, kernel, uid } = params
  const user = kernel.users.get(uid)
  if (!user) throw new Error(`startx: no user with uid ${uid}`)
  if (document.getElementById('ecmaos-desktop')) throw new Error('startx: a desktop is already running')

  const desktop = new Desktop({ kernel, username: user.username, onExit: () => instance.exit(0) })
  await desktop.start()

  // A kill from outside takes the desktop down
  instance.keepAlive()
  instance.onDispose?.(() => desktop.stop())
}

export default main
