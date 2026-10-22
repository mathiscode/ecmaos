import { describe, expect, it } from 'vitest'
import { create_thread, type HostThread } from '@zenfs/linux'

import { installWarmThreads } from '#lib/warm-threads.ts'

/** An interpreter that says where it was loaded from as soon as it starts, before the kernel has written to it */
const interpreter = () => new TextEncoder().encode(
  "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ $: 'url', url: import.meta.url })\n"
)

const firstMessage = (host: HostThread) => new Promise<{ url: string }>(resolve => host.onMessage(message => resolve(message as never)))

describe('warm threads', () => {
  installWarmThreads()

  it('hands over what a spare said before anything listened, and reuses the URL of the same bytes', async () => {
    const first = await create_thread(interpreter())
    const firstUrl = (await firstMessage(first)).url
    // started when the first was taken, so it has long said its piece by the time it is
    await new Promise(resolve => setTimeout(resolve, 500))
    const second = await create_thread(interpreter())
    expect((await firstMessage(second)).url).toBe(firstUrl)
    first.terminate()
    second.terminate()
  })

  it('gives different bytes a URL of their own', async () => {
    const other = await create_thread(new TextEncoder().encode(
      "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ $: 'url', url: import.meta.url, other: true })\n"
    ))
    const same = await create_thread(interpreter())
    const [a, b] = await Promise.all([firstMessage(other), firstMessage(same)])
    expect(a.url).not.toBe(b.url)
    other.terminate()
    same.terminate()
  })
})
