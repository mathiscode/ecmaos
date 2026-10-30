/** `stream/promises`: `pipeline` and `finished` that return promises */
const { pipeline, finished } = require('node:stream')
const { promisify } = require('node:util')
module.exports = { pipeline: promisify(pipeline), finished: promisify(finished) }
