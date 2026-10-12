/**
 * Interval management types and interfaces
 */

/**
 * Type for mapping interval names to their timer IDs
 */
export type IntervalMap = Map<string, ReturnType<typeof setInterval>>

/** Interface for interval management. */
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
