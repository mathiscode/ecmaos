/* Inspired by https://codepen.io/yaclive/pen/EayLYO */

import type { Terminal } from '@ecmaos/types'
import { openScreensaver } from '#lib/screensaver.ts'

export { exitScreensaver as exit } from '#lib/screensaver.ts'

export default async function ({ terminal }: { terminal: Terminal }) {
  const saver = openScreensaver(terminal)
  if (!saver) return false
  const { canvas, ctx } = saver

  const fontSize = 14
  const columns = Math.floor(canvas.width / fontSize)
  const drops = Array(columns).fill(1)
  const chars = '01~!#$%^&*()_+=-[]{}\\|;:",./<>?ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ'.split('')
  ctx.font = ctx.font.replace(/\d+px/, `${fontSize}px`)

  const animatrix = () => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    for (const [x, y] of drops.entries()) {
      ctx.fillStyle = '#0f0'
      const char = chars[Math.floor(Math.random() * chars.length)]
      if (!char) continue
      ctx.fillText(char, x * fontSize, y * fontSize)
      drops[x]++
      if (y * fontSize > canvas.height && Math.random() > 0.95) drops[x] = 0
    }
  }

  saver.animate(animatrix)
}
