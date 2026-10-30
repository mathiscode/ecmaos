/** `inspector`: there is no inspector to open */
module.exports = { open: () => {}, close: () => {}, url: () => undefined, waitForDebugger: () => {}, console: globalThis.console, Session: class Session { connect() {} disconnect() {} post() {} } }
