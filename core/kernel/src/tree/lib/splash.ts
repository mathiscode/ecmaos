/**
 * The boot splash the page draws before any script has run (`scripts/splash.mjs` writes it into index.html). The kernel
 * tells it what is happening; with no page, or a page without it (tests, Node, a display tab), every call does nothing.
 */
interface Splash {
  step(text: string): void
  fail(text: string): void
  show(text: string, options?: { final?: boolean }): void
  hide(): void
}

const splash = (): Splash | undefined => (globalThis as { ecmaosSplash?: Splash }).ecmaosSplash

export const bootSplash = {
  /** Marks the line before as done and starts the next */
  step: (text: string) => splash()?.step(text),
  /** Shows an error and keeps the splash up */
  fail: (text: string) => splash()?.fail(text),
  /** Brings the splash back with a line of its own: for a reboot, or a halt (`final`, with nothing more to come) */
  show: (text: string, options?: { final?: boolean }) => splash()?.show(text, options),
  /** Gives the screen to the terminal */
  hide: () => splash()?.hide()
}
