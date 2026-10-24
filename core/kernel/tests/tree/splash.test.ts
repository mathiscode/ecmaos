import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bootSplash } from '#lib/splash.ts'

import html from '../../index.html?raw'

/**
 * The boot splash is written into index.html by `scripts/splash.mjs` and moved along by the kernel through
 * `globalThis.ecmaosSplash`; this runs the page's own script against its own markup.
 */
const block = /<!--splash:start-->([\s\S]*?)<!--splash:end-->/.exec(html)![1]!
const script = /<script>([\s\S]*?)<\/script>/.exec(block)![1]!
const markup = block.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '')

const lines = () => [...document.querySelectorAll('#splash-lines .line')].map(line => line.textContent)
const root = () => document.getElementById('splash') as HTMLElement

describe('boot splash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = markup
    delete (globalThis as { ecmaosSplash?: unknown }).ecmaosSplash
    new Function(script)()
  })

  it('shows the logo and a first line before any script of the kernel runs', () => {
    expect(root().querySelector('pre')?.textContent).toContain('@@@')
    expect(lines()).toEqual(['[ .. ] Loading kernel'])
  })

  it('marks a line done when the next step starts', () => {
    bootSplash.step('Mounting the filesystem')
    expect(lines()).toEqual(['[ OK ] Loading kernel', '[ .. ] Mounting the filesystem'])
  })

  it('explains a long wait after five seconds, and not after it has gone', () => {
    const slow = document.getElementById('splash-slow') as HTMLElement
    vi.advanceTimersByTime(4000)
    expect(slow.hidden).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(slow.hidden).toBe(false)
    bootSplash.hide()
    vi.advanceTimersByTime(400)
    expect(root().hidden).toBe(true)
  })

  it('shows a failure while it is up, and leaves the terminal to report one after it has gone', () => {
    bootSplash.fail('Boot failed: no storage')
    expect(lines()).toEqual(['[FAIL] Loading kernel', ' Boot failed: no storage'])
    bootSplash.hide()
    vi.advanceTimersByTime(400)
    bootSplash.fail('late')
    expect(lines()).toHaveLength(2)
  })

  it('comes back for a reboot or a halt, with nothing more to come on a halt', () => {
    bootSplash.hide()
    vi.advanceTimersByTime(400)
    bootSplash.show('System halted', { final: true })
    expect(root().hidden).toBe(false)
    expect(lines()).toEqual([' System halted'])
    expect(root().querySelector('.pending')).toBeNull()
  })

  it('does nothing without a page', () => {
    delete (globalThis as { ecmaosSplash?: unknown }).ecmaosSplash
    expect(() => { bootSplash.step('x'); bootSplash.fail('x'); bootSplash.show('x'); bootSplash.hide() }).not.toThrow()
  })
})
