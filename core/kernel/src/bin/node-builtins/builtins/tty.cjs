/** Node's `tty`: whether a descriptor is a terminal */
const sys = globalThis.ecmaosSyscalls
const isatty = fd => { try { sys.tcgetattr(fd); return true } catch { return false } }
module.exports = {
  isatty,
  ReadStream: class ReadStream {},
  WriteStream: class WriteStream {}
}
