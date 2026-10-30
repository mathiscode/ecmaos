/** Node's `timers`: the same objects the globals are, which keep the program alive until they run */
const { timers } = require('node:process').__ecmaos
module.exports = { ...timers, promises: require('node:timers/promises') }
