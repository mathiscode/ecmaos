/** Reads descriptor 0 to the end and returns it as one string. */
export function readAllStdin({ read }) {
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(65536)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { bytes.set(c, offset); offset += c.length }
  return new TextDecoder().decode(bytes)
}
