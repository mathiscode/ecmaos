/**
 * The nameserver at 127.0.0.1:53, for programs whose C library does its own lookups (musl: python3, perl, anything built
 * with it). They read `/etc/resolv.conf`, send a DNS query by UDP and wait for the answer; this answers it from the same
 * place `host` and `dig` do (`/etc/hosts`, then the gateway's resolver), so a name resolves in a program exactly as it
 * does in a command. A and AAAA are answered; any other type gets an empty answer, as a server with no such record
 * would, and a name that does not exist is NXDOMAIN. With no gateway up the answer is SERVFAIL, which a library reads as
 * "try again".
 */

import { LookupFailure } from './remote-gateway.ts'

const TypeA = 1
const TypeAAAA = 28
const ClassIN = 1

/** How long a program may keep an answer; the gateway's resolver does not pass the record's own TTL on */
const Ttl = 30

export type Lookup = (name: string, family: 4 | 6) => Promise<string[]>

interface Question {
  name: string
  type: number
  /** The question as it was asked, to be copied into the answer */
  raw: Uint8Array
}

/** The first question of a query, or undefined when it is not a well-formed standard query */
function questionOf(query: Uint8Array): Question | undefined {
  if (query.length < 17) return undefined
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength)
  const flags = view.getUint16(2)
  // a query (QR 0) with the standard opcode and one or more questions
  if ((flags & 0xf800) !== 0 || view.getUint16(4) < 1) return undefined
  const labels: string[] = []
  let at = 12
  for (;;) {
    const size = query[at++]
    if (size === undefined || size > 63) return undefined // a compression pointer cannot start a question
    if (size === 0) break
    if (at + size > query.length) return undefined
    labels.push(new TextDecoder().decode(query.subarray(at, at + size)))
    at += size
  }
  if (at + 4 > query.length || view.getUint16(at + 2) !== ClassIN) return undefined
  return { name: labels.join('.'), type: view.getUint16(at), raw: query.subarray(12, at + 4) }
}

function address(text: string): Uint8Array {
  if (!text.includes(':')) return Uint8Array.from(text.split('.').map(Number))
  const [head = '', tail] = text.split('::')
  const part = (side: string) => side ? side.split(':') : []
  const groups = [...part(head), ...(tail === undefined ? [] : Array<string>(8 - part(head).length - part(tail).length).fill('0')), ...part(tail ?? '')]
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => { const value = parseInt(group, 16); bytes[index * 2] = value >> 8; bytes[index * 2 + 1] = value & 0xff })
  return bytes
}

function reply(query: Uint8Array, question: Question, code: number, addresses: string[]): Uint8Array {
  const rdata = addresses.map(address)
  const size = 12 + question.raw.length + rdata.reduce((total, data) => total + 12 + data.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set(query.subarray(0, 2)) // the id
  // a response, recursion desired as asked and available, with the rcode
  view.setUint16(2, 0x8000 | (query[2]! & 0x01) << 8 | 0x0080 | code)
  view.setUint16(4, 1)
  view.setUint16(6, rdata.length)
  out.set(question.raw, 12)
  let at = 12 + question.raw.length
  for (const data of rdata) {
    view.setUint16(at, 0xc00c) // the name, by pointer to the question
    view.setUint16(at + 2, data.length === 4 ? TypeA : TypeAAAA)
    view.setUint16(at + 4, ClassIN)
    view.setUint32(at + 6, Ttl)
    view.setUint16(at + 10, data.length)
    out.set(data, at + 12)
    at += 12 + data.length
  }
  return out
}

/** The response to a DNS query datagram, or undefined when it is not one to answer (it is dropped, as a server would) */
export async function answerQuery(query: Uint8Array, lookup: Lookup): Promise<Uint8Array | undefined> {
  const question = questionOf(query)
  if (!question) return undefined
  if (question.type !== TypeA && question.type !== TypeAAAA) return reply(query, question, 0, [])
  const family = question.type === TypeA ? 4 : 6
  try {
    return reply(query, question, 0, await lookup(question.name, family))
  } catch (error) {
    if (!(error instanceof LookupFailure) || error.kind !== 'NONAME') return reply(query, question, 2, []) // SERVFAIL
    // a name with addresses of the other family only has no record of this type (NOERROR, empty): musl takes NXDOMAIN
    // on either of its two queries as "no such name" and drops the other's answer
    const other = await lookup(question.name, family === 4 ? 6 : 4).then(found => found.length > 0, () => false)
    return reply(query, question, other ? 0 : 3, []) // 3 is NXDOMAIN
  }
}
