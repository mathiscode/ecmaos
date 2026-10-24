/** The socket tables of `/proc/net` (`tcp`, `tcp6`, `udp`, `udp6`, `unix`), parsed, for `ss` and the commands like it. */

import { readTextFile } from './fs-text.mjs'

const TcpStates = { '01': 'ESTAB', '02': 'SYN-SENT', '03': 'SYN-RECV', '04': 'FIN-WAIT-1', '05': 'FIN-WAIT-2', '06': 'TIME-WAIT', '07': 'UNCONN', '08': 'CLOSE-WAIT', '09': 'LAST-ACK', '0A': 'LISTEN', '0B': 'CLOSING' }

/** The bytes of an address as `/proc/net` prints them: the hex of each 32-bit word, in the machine's little-endian order */
function addressBytes(hex) {
  const bytes = []
  for (let i = 0; i < hex.length; i += 8) {
    for (let j = 6; j >= 0; j -= 2) bytes.push(parseInt(hex.slice(i + j, i + j + 2), 16))
  }
  return bytes
}

/** `127.0.0.1`, or an IPv6 address in RFC 5952 form (the longest run of zero groups as `::`) */
export function formatAddress(hex) {
  const bytes = addressBytes(hex)
  if (bytes.length === 4) return bytes.join('.')
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1])
  let best = { at: -1, length: 0 }
  for (let i = 0; i < 8; i++) {
    let length = 0
    while (i + length < 8 && groups[i + length] === 0) length++
    if (length > best.length) best = { at: i, length }
  }
  if (best.length < 2) return groups.map(group => group.toString(16)).join(':')
  const head = groups.slice(0, best.at).map(group => group.toString(16)).join(':')
  const tail = groups.slice(best.at + best.length).map(group => group.toString(16)).join(':')
  return `${head}::${tail}`
}

function readTable(path) {
  try { return readTextFile(path).split('\n').slice(1).filter(line => line.trim() !== '') } catch { return [] }
}

/** Every TCP or UDP socket in the tables: `{ netid, state, local, localPort, peer, peerPort, uid, inode, six }` */
export function inetSockets() {
  const sockets = []
  for (const [netid, name] of [['tcp', 'tcp'], ['tcp', 'tcp6'], ['udp', 'udp'], ['udp', 'udp6']]) {
    for (const line of readTable(`/proc/net/${name}`)) {
      const fields = line.trim().split(/\s+/)
      const [local, localPort] = fields[1].split(':')
      const [peer, peerPort] = fields[2].split(':')
      const state = TcpStates[fields[3]] ?? fields[3]
      sockets.push({
        netid, state, six: name.endsWith('6'),
        local: formatAddress(local), localPort: parseInt(localPort, 16),
        peer: formatAddress(peer), peerPort: parseInt(peerPort, 16),
        uid: Number(fields[7]), inode: fields[9]
      })
    }
  }
  return sockets
}

/** Every Unix socket: `{ netid: 'u_str', state, path, inode }` (a listening one is LISTEN, any other UNCONN or ESTAB) */
export function unixSockets() {
  return readTable('/proc/net/unix').map(line => {
    const fields = line.trim().split(/\s+/)
    const flags = parseInt(fields[3], 16)
    return {
      netid: 'u_str',
      state: flags & 0x10000 ? 'LISTEN' : fields[5] === '03' ? 'ESTAB' : 'UNCONN',
      path: fields[7] ?? '*',
      inode: fields[6]
    }
  })
}
