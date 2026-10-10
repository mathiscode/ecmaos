import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

/**
 * A browser holds clipboard and notification calls until the page has focus or the user answers a prompt, and
 * says nothing meanwhile, so a program waiting on one would wait for ever. `ms` is how long to wait.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

const ClipboardWait = 10_000
const PermissionWait = 30_000
const NoAnswer = 'the browser did not answer; is the page in focus?'

/** Shows a desktop notification (`notify-send`). Asks for permission the first time. */
export async function presentNotify(_kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<Presented> {
  const title = params['title']
  if (typeof title !== 'string' || !title) throw new Error('missing summary')
  if (typeof Notification === 'undefined') throw new Error('this browser has no notifications')

  let permission = Notification.permission
  if (permission === 'default') permission = await withDeadline(Promise.resolve(Notification.requestPermission()), PermissionWait, NoAnswer)
  if (permission !== 'granted') throw new Error('notifications are blocked for this site')

  const body = typeof params['body'] === 'string' ? params['body'] : undefined
  const tag = typeof params['tag'] === 'string' ? params['tag'] : undefined
  const icon = typeof params['icon'] === 'string' ? params['icon'] : undefined
  new Notification(title, { body, tag, icon })
  return { result: { shown: true } }
}

/** Puts text on the clipboard (`xclip`, `pbcopy`). */
export async function presentClipboardWrite(_kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<Presented> {
  const text = params['text']
  if (typeof text !== 'string') throw new Error('missing text')
  if (!navigator.clipboard?.writeText) throw new Error('this browser has no clipboard access here')
  await withDeadline(navigator.clipboard.writeText(text), ClipboardWait, NoAnswer)
  return { result: { bytes: new TextEncoder().encode(text).length } }
}

/** Reads the clipboard text (`xclip -o`, `pbpaste`). The browser may ask the user first. */
export async function presentClipboardRead(): Promise<Presented> {
  if (!navigator.clipboard?.readText) throw new Error('this browser has no clipboard access here')
  return { result: { text: await withDeadline(navigator.clipboard.readText(), PermissionWait, NoAnswer) } }
}

/** Speaks text (`say`), or lists the voices. The process lives until the speech ends or is killed. */
export function presentSpeak(_kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Presented {
  const synth = globalThis.speechSynthesis
  if (!synth) throw new Error('this browser has no speech synthesis')

  if (params['voices']) {
    return { result: { voices: synth.getVoices().map(v => ({ name: v.name, lang: v.lang })) } }
  }

  const text = params['text']
  if (typeof text !== 'string' || !text) throw new Error('nothing to say')
  const utterance = new SpeechSynthesisUtterance(text)
  if (typeof params['lang'] === 'string') utterance.lang = params['lang']
  if (typeof params['rate'] === 'number') utterance.rate = params['rate']
  if (typeof params['pitch'] === 'number') utterance.pitch = params['pitch']
  if (typeof params['voice'] === 'string') {
    const voice = synth.getVoices().find(v => v.name === params['voice'])
    if (!voice) throw new Error(`no voice named ${params['voice']}`)
    utterance.voice = voice
  }

  const closed = new Promise<unknown>((resolve, reject) => {
    utterance.onend = () => resolve({ spoken: true })
    utterance.onerror = e => (e.error === 'canceled' || e.error === 'interrupted') ? resolve({ spoken: false }) : reject(new Error(`speech failed: ${e.error}`))
  })
  synth.speak(utterance)
  return { result: null, closed, dispose: () => synth.cancel() }
}
