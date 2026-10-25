import { describe, expect, it } from 'vitest'

import { answerQuery } from '#lib/dns-stub.ts'
import { LookupFailure } from '#lib/remote-gateway.ts'

/** A standard query for `name` with the given id, as musl sends it */
function query(name: string, type: number, id = 0x1234): Uint8Array {
  const labels = name.split('.').flatMap(label => [label.length, ...new TextEncoder().encode(label)])
  return Uint8Array.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, type >> 8, type & 0xff, 0, 1])
}

const header = (answer: Uint8Array) => ({ id: (answer[0]! << 8) | answer[1]!, response: (answer[2]! & 0x80) !== 0, rcode: answer[3]! & 0x0f, answers: (answer[6]! << 8) | answer[7]! })

describe('the nameserver on loopback port 53', () => {
  const book: Record<string, { 4?: string[], 6?: string[] }> = {
    'example.test': { 4: ['203.0.113.9'], 6: ['2001:db8::1'] },
    'v6only.test': { 6: ['2001:db8::2'] }
  }
  const lookup = async (name: string, family: 4 | 6) => {
    if (name === 'down.test') throw new LookupFailure('AGAIN', 'no gateway is up')
    const found = book[name]
    if (!found) throw new LookupFailure('NONAME', `${name}: no address`)
    const addresses = found[family] ?? []
    if (addresses.length === 0) throw new LookupFailure('NONAME', `${name}: no address`)
    return addresses
  }

  it('answers an A query with the address, under the id it came with', async () => {
    const answer = (await answerQuery(query('example.test', 1, 0xbeef), lookup))!
    expect(header(answer)).toEqual({ id: 0xbeef, response: true, rcode: 0, answers: 1 })
    // question copied, then the record: a pointer to the name, A, IN, TTL 30, four bytes
    const record = answer.subarray(answer.length - 16)
    expect([...record]).toEqual([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 203, 0, 113, 9])
  })

  it('answers AAAA with sixteen bytes', async () => {
    const answer = (await answerQuery(query('example.test', 28), lookup))!
    expect(header(answer).answers).toBe(1)
    expect([...answer.subarray(answer.length - 16)]).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('says a name has no record of a type, and not that it does not exist, when the other family has one', async () => {
    expect(header((await answerQuery(query('v6only.test', 1), lookup))!)).toMatchObject({ rcode: 0, answers: 0 })
    expect(header((await answerQuery(query('v6only.test', 28), lookup))!)).toMatchObject({ rcode: 0, answers: 1 })
  })

  it('says NXDOMAIN for a name with no address of either family, and SERVFAIL when it cannot ask', async () => {
    expect(header((await answerQuery(query('nothing.test', 1), lookup))!).rcode).toBe(3)
    expect(header((await answerQuery(query('down.test', 1), lookup))!).rcode).toBe(2)
  })

  it('gives an empty answer to a type it does not know, without looking anything up', async () => {
    let asked = 0
    const answer = (await answerQuery(query('example.test', 65), async () => { asked++; return [] }))!
    expect(header(answer)).toMatchObject({ rcode: 0, answers: 0 })
    expect(asked).toBe(0)
  })

  it('drops what is not a query', async () => {
    expect(await answerQuery(new Uint8Array(5), lookup)).toBeUndefined()
    const response = query('example.test', 1)
    response[2] = 0x81
    expect(await answerQuery(response, lookup)).toBeUndefined()
  })
})
