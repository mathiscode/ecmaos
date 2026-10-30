/** Node's `buffer` */
const { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength } = require('@polyfill/buffer')

module.exports = {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
  kStringMaxLength: 536870888,
  constants: { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 536870888 },
  Blob: globalThis.Blob,
  File: globalThis.File,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  isUtf8: bytes => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false } },
  isAscii: bytes => Array.prototype.every.call(bytes, byte => byte < 0x80)
}
