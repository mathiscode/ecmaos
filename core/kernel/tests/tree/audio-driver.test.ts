import { describe, expect, it, vi } from 'vitest'

import { getDrivers, openPlayerSession } from '@ecmaos-devices/audio'

const environment = (decode: (bytes: ArrayBuffer) => Promise<unknown>) => {
  const started: unknown[] = []
  const gain = { gain: { value: 1 }, connect: vi.fn() }
  const context = {
    destination: {}, resume: async () => {}, close: vi.fn(async () => {}),
    decodeAudioData: decode, createGain: () => gain,
    createBufferSource: () => ({ buffer: null, connect: vi.fn(), start: () => started.push(1), onended: null })
  }
  return { started, gain, context, environment: { createContext: () => context as never, getUserMedia: async () => { throw new Error('no') } } }
}

describe('audio nodes', () => {
  it('are /dev/audio, /dev/dsp, /dev/dsp1 and /dev/dspin on major 14 with their own minors', async () => {
    const drivers = await getDrivers({ log: { error: vi.fn() } } as never)
    expect(drivers.map(driver => [driver.name, driver.major, driver.minor])).toEqual([['audio', 14, 4], ['dsp', 14, 3], ['dsp1', 14, 19], ['dspin', 14, 5]])
    expect(new Set(drivers.map(driver => driver.ops)).size).toBe(4)
  })
})

describe('the file player', () => {
  it('collects what is written, then decodes and plays it on close at the chosen volume', async () => {
    const seen: number[] = []
    const fake = environment(async bytes => { seen.push(bytes.byteLength); return {} })
    const session = await openPlayerSession({ environment: fake.environment })
    await session.control!('volume', [0.5])
    await session.write!(new Uint8Array([1, 2, 3]))
    await session.write!(new Uint8Array([4, 5]))
    expect(fake.started).toHaveLength(0)
    await session.close()
    expect(seen).toEqual([5])
    expect(fake.started).toHaveLength(1)
    expect(fake.gain.gain.value).toBe(0.5)
  })

  it('plays nothing for an empty file and rejects a bad volume', async () => {
    const fake = environment(async () => ({}))
    const session = await openPlayerSession({ environment: fake.environment })
    await expect(session.control!('volume', [2])).rejects.toMatchObject({ code: 'EINVAL' })
    await session.close()
    expect(fake.started).toHaveLength(0)
  })

  it('reports a file that cannot be decoded and frees the context', async () => {
    const fake = environment(async () => { throw new Error('bad data') })
    const onError = vi.fn()
    const session = await openPlayerSession({ environment: fake.environment, onError })
    await session.write!(new Uint8Array([9]))
    await session.close()
    expect(onError.mock.calls[0]![0].message).toBe('bad data')
    expect(fake.context.close).toHaveBeenCalled()
  })
})
