import type { IntervalMap } from '@ecmaos/types'

/**
 * Plain named `setInterval` handles (e.g. the title-blink interval) -- the cron half that used to
 * live here (`setCron`/`getCron`/`clearCron`/`listCrons`, backed by `cron-schedule`'s
 * `TimerBasedCronScheduler`) was retired once `crond` (`src/bin/commands/crond.mjs`) became a real,
 * long-running daemon `Process` owning its own schedule -- those closures ran main-thread-only with
 * no pid, invisible to `ps` and unkillable; `crond` fixes both. See `crond.mjs`'s own doc comment.
 */
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

  clear(name: string) {
    const interval = this._intervals.get(name)
    if (interval) {
      clearInterval(interval)
      this._intervals.delete(name)
    }
  }
}
