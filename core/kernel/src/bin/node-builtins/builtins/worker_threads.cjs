/** `worker_threads`: this is the main thread and there are no others to start */
const { EventEmitter } = require('node:events')

class Worker extends EventEmitter {
  constructor() { super(); throw Object.assign(new Error('Worker threads are not available in ecmaOS programs'), { code: 'ERR_WORKER_UNSUPPORTED_OPERATION' }) }
}

module.exports = { isMainThread: true, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, Worker, MessageChannel: globalThis.MessageChannel, MessagePort: globalThis.MessagePort, BroadcastChannel: globalThis.BroadcastChannel, SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'), markAsUntransferable: () => {}, receiveMessageOnPort: () => undefined }
