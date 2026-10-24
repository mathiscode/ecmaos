#!/usr/bin/env node
// The boot splash: what the page shows from its first byte until the terminal prints its own logo, so the screen is
// not black while the kernel downloads and starts. It is plain HTML, CSS and a small script written into index.html and
// index-dist.html between the splash markers (the second is copied over dist/index.html after a build, so vite never
// sees it), with the logo rendered here, once, in the font and text the terminal's banner uses.
//
//   node scripts/splash.mjs           rewrite both files
//   node scripts/splash.mjs --check   exit 1 if either is out of date
//
// The kernel moves it along through `globalThis.ecmaosSplash` (src/lib/splash.ts): step(text) marks the line before as
// done and starts the next, fail(text) shows an error, show(text, { final }) brings it back (reboot, halt) and hide()
// hands the screen to the terminal (fail() then leaves it alone: the terminal reports its own).
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import figlet from 'figlet'
import font from 'figlet/importable-fonts/Poison.js'

const root = path.resolve(import.meta.dirname, '..')
const text = process.env.FIGLET_TEXT || 'ECMAOS'
figlet.parseFont('Poison', font)
const logo = figlet.textSync(text, { font: 'Poison' }).replace(/\s+$/, '').split('\n').map(line => line.replace(/\s+$/, '')).join('\n')
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const block = `<!--splash:start-->
    <style>
      #splash { position: fixed; inset: 0; z-index: 99999; box-sizing: border-box; overflow: auto; padding: 24px 16px; background: #000; color: #00cc00; font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: 1; transition: opacity 0.25s ease-out; }
      #splash.out { opacity: 0; pointer-events: none; }
      #splash[hidden] { display: none; }
      #splash pre { margin: 0 0 20px; font: inherit; line-height: 1.15; }
      #splash .line { white-space: pre-wrap; }
      #splash .tag { display: inline-block; min-width: 8ch; }
      #splash .pending .tag { color: #cccc00; animation: splash-blink 1s steps(2, start) infinite; }
      #splash .fail { color: #ff4444; }
      #splash .slow { margin-top: 16px; color: #888; }
      @keyframes splash-blink { to { visibility: hidden; } }
      @media (max-width: 649px) { #splash pre { display: none; } }
      @media (prefers-reduced-motion: reduce) { #splash { transition: none; } #splash .pending .tag { animation: none; } }
    </style>
    <div id="splash" role="status" aria-live="polite">
      <pre aria-label="${escape(text)}">${escape(logo)}</pre>
      <div id="splash-lines"><div class="line pending"><span class="tag">[ .. ]</span> Loading kernel</div></div>
      <div id="splash-slow" class="slow" hidden>The first load downloads the system; this can take a minute.</div>
    </div>
    <script>
      (function () {
        var root = document.getElementById('splash'), lines = document.getElementById('splash-lines'), slow = document.getElementById('splash-slow')
        var last, timer
        function tag(node, name, label) { node.className = 'line ' + name; node.firstChild.textContent = label }
        function done(ok) { if (last && last.className.indexOf('pending') >= 0) tag(last, ok ? 'ok' : 'fail', ok ? '[ OK ]' : '[FAIL]') }
        function add(text, pending) {
          var line = document.createElement('div'), mark = document.createElement('span')
          mark.className = 'tag'
          line.appendChild(mark)
          line.appendChild(document.createTextNode(' ' + text))
          tag(line, pending ? 'pending' : 'ok', pending ? '[ .. ]' : '')
          lines.appendChild(line)
          last = line
          return line
        }
        function later() { clearTimeout(timer); timer = setTimeout(function () { if (!root.hidden) slow.hidden = false }, 5000) }
        last = lines.firstChild
        later()
        window.ecmaosSplash = {
          step: function (text) { done(true); add(text, true) },
          fail: function (text) {
            if (root.hidden || root.classList.contains('out')) return // the terminal has the screen and reports its own
            clearTimeout(timer); done(false); add(text, false).className = 'line fail'
          },
          show: function (text, options) {
            clearTimeout(timer); lines.textContent = ''; slow.hidden = true
            root.classList.remove('out'); root.hidden = false
            if (options && options.final) add(text, false); else { add(text, true); later() }
          },
          hide: function () {
            clearTimeout(timer)
            if (root.hidden) return
            root.classList.add('out')
            setTimeout(function () { if (root.classList.contains('out')) root.hidden = true }, 300)
          }
        }
      })()
    </script>
    <!--splash:end-->`

let stale = false
for (const name of ['index.html', 'index-dist.html']) {
  const file = path.join(root, name)
  const html = readFileSync(file, 'utf8')
  const next = html.includes('<!--splash:start-->')
    ? html.replace(/<!--splash:start-->[\s\S]*?<!--splash:end-->/, () => block)
    : html.replace(/(<body>\n)/, (_, body) => `${body}    ${block}\n`)
  if (next === html) continue
  if (process.argv.includes('--check')) { console.error(`${name}: the splash is out of date (node scripts/splash.mjs)`); stale = true } else writeFileSync(file, next)
}
process.exit(stale ? 1 : 0)
