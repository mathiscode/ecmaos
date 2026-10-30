/** `dns`: names resolve through the host's DNS-over-HTTPS (the `host` and `dig` commands), which a program cannot call yet */
const unavailable = Object.assign(new Error('dns lookups are not available in ecmaOS programs yet'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
const fail = (...args) => { const callback = args.at(-1); if (typeof callback === 'function') setTimeout(callback, 0, unavailable); else throw unavailable }
const promises = { lookup: async () => { throw unavailable }, resolve: async () => { throw unavailable }, resolve4: async () => { throw unavailable }, resolve6: async () => { throw unavailable } }
module.exports = { lookup: fail, resolve: fail, resolve4: fail, resolve6: fail, reverse: fail, setDefaultResultOrder: () => {}, getServers: () => [], promises }
