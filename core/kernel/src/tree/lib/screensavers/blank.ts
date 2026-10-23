import type { Terminal } from '@ecmaos/types'
import { openScreensaver } from '#lib/screensaver.ts'

export { exitScreensaver as exit } from '#lib/screensaver.ts'

export default async function ({ terminal }: { terminal: Terminal }) {
  const saver = openScreensaver(terminal, 1000000)
  if (!saver) return false
  saver.ctx.fillStyle = 'black'
  saver.ctx.fillRect(0, 0, saver.canvas.width, saver.canvas.height)
}
