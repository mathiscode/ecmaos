// Non-standard, Chromium-only extensions used to back /proc/cpuinfo and /proc/meminfo with real
// values rather than fabricated ones. Absent in other engines; every call site treats them as optional.

interface Navigator {
  /** Approximate device memory in GiB, rounded to a power of two. Chromium only. */
  readonly deviceMemory?: number
}

interface Performance {
  /** Chromium-only heap size snapshot. */
  readonly memory?: {
    readonly jsHeapSizeLimit: number
    readonly totalJSHeapSize: number
    readonly usedJSHeapSize: number
  }
}
