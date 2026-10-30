/** Node's `https` client over `fetch` (`https-browserify`) */
const https = require('@polyfill/https')
const http = require('node:http')

module.exports = { ...https, createServer: http.createServer, Server: http.Server, globalAgent: https.globalAgent ?? http.globalAgent }
