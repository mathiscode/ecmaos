const { Interface } = require('node:readline')

class PromisesInterface extends Interface {
  question(query, options) {
    return new Promise((resolve, reject) => {
      try { super.question(query, options, resolve) } catch (error) { reject(error) }
    })
  }
}

module.exports = { Interface: PromisesInterface, createInterface: (input, output, completer, terminal) => new PromisesInterface(input, output, completer, terminal) }
