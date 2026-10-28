/**
 * `/proc/meminfo`. A browser says how much memory the machine has only in Chrome (`navigator.deviceMemory`) and how full
 * the JavaScript heap is only in Chrome too (`performance.memory`); the Node host asks the operating system through
 * `setHostMemory`. What none of them can measure is left out rather than made up, except what cannot be anything else:
 * there is no swap, and the page cache, buffers and dirty pages are not visible to the kernel, so those read 0.
 */

/** Bytes, as `os.totalmem()` and `os.freemem()` give them */
export interface HostMemory {
  total: number
  free: number
}

let host: (() => HostMemory) | undefined

/** Where the Node host says how much memory its machine has; the browser has no such call */
export function setHostMemory(source: (() => HostMemory) | undefined): void { host = source }

const kb = (bytes: number) => Math.round(bytes / 1024)
const line = (name: string, value: number) => `${`${name}:`.padEnd(15)}${String(value).padStart(8)} kB`

export function showMeminfo(): string {
  const lines: string[] = []
  const measured = host?.()
  if (measured) {
    lines.push(line('MemTotal', kb(measured.total)), line('MemFree', kb(measured.free)), line('MemAvailable', kb(measured.free)))
  } else {
    if ('deviceMemory' in navigator && navigator.deviceMemory) lines.push(line('MemTotal', Math.round(navigator.deviceMemory * 1024 * 1024)))
    if (performance.memory) {
      const { totalJSHeapSize, usedJSHeapSize, jsHeapSizeLimit } = performance.memory
      lines.push(line('MemFree', kb(totalJSHeapSize - usedJSHeapSize)), line('MemAvailable', kb(jsHeapSizeLimit - usedJSHeapSize)))
    }
  }
  if (!lines.length) return ''
  for (const name of ['Buffers', 'Cached', 'SwapCached', 'SwapTotal', 'SwapFree', 'Dirty', 'Writeback', 'Shmem']) lines.push(line(name, 0))
  return lines.join('\n') + '\n'
}
