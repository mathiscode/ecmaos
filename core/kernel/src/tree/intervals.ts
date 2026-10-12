import type { IntervalMap } from '@ecmaos/types'

/** Plain named `setInterval` handles (e.g. the title-blink interval). Scheduling cron jobs is `crond`'s business. */
export class Intervals {
  private _intervals: IntervalMap = new Map()

  get(name: string) {
    return this._intervals.get(name)
  }

  set(name: string, callback: () => void, interval: number) {
    const intervalId = setInterval(callback, interval)
    this._intervals.set(name, intervalId)
    return intervalId
  }

  /** Stops every interval; the kernel does this on shutdown so nothing keeps the process alive */
  clearAll() {
    for (const name of [...this._intervals.keys()]) this.clear(name)
  }

  clear(name: string) {
    const interval = this._intervals.get(name)
    if (interval) {
      clearInterval(interval)
      this._intervals.delete(name)
    }
  }
}
