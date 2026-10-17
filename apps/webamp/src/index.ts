import Webamp from 'webamp'

import type { AppSdk, ProcessEntryParams } from '@ecmaos/types'

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

  // `keepAlive` ties the process to the player: `onClose` (the user closes the player) exits the process; `onDispose`
  // (killed from outside) disposes the player.
  instance.keepAlive()
  player.onClose(() => instance.exit(0))
  instance.onDispose?.(() => player.dispose())
}

/**
 * The entry for a host with no page of its own (a Node process): the player runs in the sandbox of its window, and the files
 * named on the command line are read through the SDK.
 */
export const display = async (sdk: AppSdk) => {
  if (!(Webamp as any).browserIsSupported()) throw new Error('Browser does not support necessary features for webamp')

  const tracks: Array<{ url: string, metaData: { title: string } }> = []
  for (const arg of sdk.args) {
    const bytes = await sdk.fs.readFile(arg)
    tracks.push({ url: URL.createObjectURL(new Blob([new Uint8Array(bytes)])), metaData: { title: arg.split('/').pop() ?? arg } })
  }

  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const player = new (Webamp as any)(tracks.length ? { initialTracks: tracks } : {})
  await player.renderWhenReady(mount)
  player.onClose(() => { void sdk.exit(0) })
  sdk.onDispose(() => player.dispose())
  await sdk.window.setTitle('Webamp')
}

export default main
