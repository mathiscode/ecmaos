/** `timers/promises`: `setTimeout(delay, value)`, `setImmediate(value)` and `setInterval` as an async iterator */
const { timers } = require('node:process').__ecmaos

const abortError = signal => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal?.reason })

function wait(start, options = {}, value) {
  const { signal, ref = true } = options
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = start(() => { signal?.removeEventListener('abort', onAbort); resolve(value) })
    if (!ref) timer.unref()
    const onAbort = () => { timers.clearTimeout(timer); reject(abortError(signal)) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

module.exports = {
  setTimeout: (delay, value, options) => wait(done => timers.setTimeout(done, delay), options, value),
  setImmediate: (value, options) => wait(done => timers.setImmediate(done), options, value),
  async * setInterval(delay, value, options = {}) {
    const { signal } = options
    for (;;) {
      await wait(done => timers.setTimeout(done, delay), options)
      if (signal?.aborted) return
      yield value
    }
  },
  scheduler: { wait: (delay, options) => wait(done => timers.setTimeout(done, delay), options), yield: () => wait(done => timers.setImmediate(done)) }
}
