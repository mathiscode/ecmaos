/**
 * Interval management types and interfaces
 */

/**
 * Type for mapping interval names to their timer IDs
 */
export type IntervalMap = Map<string, ReturnType<typeof setInterval>>

/**
 * Interface for interval management functionality
 *
 * The cron half this used to declare (`setCron`/`getCron`/`clearCron`/`listCrons`, backed by
 * `cron-schedule`'s `TimerBasedCronScheduler`) was retired once `crond` became a real, long-running
 * daemon `Process` owning its own schedule -- see `core/kernel/src/bin/commands/crond.mjs`'s own doc
 * comment for why.
 */
export interface Intervals {
  /**
   * Get an interval by name
   * @param name - Name of the interval
   */
  get(name: string): ReturnType<typeof setInterval> | undefined

  /**
   * Set a new interval
   * @param name - Name for the interval
   * @param callback - Function to execute
   * @param interval - Time in milliseconds between executions
   */
  set(name: string, callback: () => void, interval: number): ReturnType<typeof setInterval>

  /**
   * Clear an interval by name
   * @param name - Name of the interval to clear
   */
  clear(name: string): void
}
