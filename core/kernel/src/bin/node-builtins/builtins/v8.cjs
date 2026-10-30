/** `v8`: heap numbers from the browser where it tells them, and a structured clone for `serialize` and `deserialize` */
const memory = () => globalThis.performance?.memory ?? {}
module.exports = {
  getHeapStatistics: () => ({ total_heap_size: memory().totalJSHeapSize ?? 0, used_heap_size: memory().usedJSHeapSize ?? 0, heap_size_limit: memory().jsHeapSizeLimit ?? 0, total_available_size: 0, total_physical_size: 0, malloced_memory: 0, peak_malloced_memory: 0, external_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  setFlagsFromString: () => {},
  serialize: value => Buffer.from(JSON.stringify(value)),
  deserialize: buffer => JSON.parse(buffer.toString()),
  cachedDataVersionTag: () => 0
}
