import Webamp from 'webamp'

import type { ProcessEntryParams } from '@ecmaos/types'

const main = async (params: ProcessEntryParams) => {
  // const Webamp = WebampModule.default
  // console.log(WebampModule)
  const { args, command, cwd, gid, instance, kernel, pid, shell, terminal, stdin, stdout, stderr, uid } = params
  if (!(Webamp as any).browserIsSupported()) throw new Error('Browser does not support necessary features for webamp')

  const mount = document.createElement('div')
  mount.style.position = 'absolute'
  mount.style.top = '0'
  mount.style.right = '0'

  const playerOptions = {
    zIndex: Number.MAX_SAFE_INTEGER - 1,
    initialTracks: [
      {
        url: 'https://cdn.jsdelivr.net/gh/captbaritone/webamp@43434d82cfe0e37286dbbe0666072dc3190a83bc/mp3/llama-2.91.mp3',
        duration: 5.322286,
        metaData: {
          artist: 'DJ Mike Llama',
          title: "Llama Whippin' Intro"
        }
      }
    ]
  }

  const player = new (Webamp as any)(playerOptions)
  document.body.appendChild(mount)
  player.renderWhenReady(mount)

  // Without this, `main` returning right after render resolves the process's `closed` promise
  // immediately, so the process exits while the player is still open -- its lifetime was never
  // actually tied to the process's. `keepAlive` ties it to the player's own close, the same way
  // `apps/code/src/main.ts` ties its process to its editor window: `onClose` (the user closing
  // the player through its own UI) exits the process; `onDispose` (killed from outside) disposes
  // the player, since nothing else can reach into it once the process is gone.
  instance.keepAlive()
  player.onClose(() => instance.exit(0))
  instance.onDispose?.(() => player.dispose())
}

export default main
