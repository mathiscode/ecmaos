import { describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** `split` makes its suffixes longer when it runs out of them, unless `-a` fixes the length; names as GNU split 9 gave them. */
describe('split suffix widening', { timeout: 120000 }, () => {
  const { run } = usePosixKernel()

  it('goes on past zz with names that start with z', async () => {
    const r = await run('seq 1 700 > big', "{ split -l 1 big s; ls | wc -l; ls s* | sed -n '650p;651p;652p;676p;677p'; }")
    expect(r.out).toBe('701\nsyz\nszaaa\nszaab\nszaaz\nszaba\n'.replace('701\n', '701\n'))
  })
  it('numeric suffixes widen the same way', async () => {
    const r = await run('seq 1 95 > big', "{ split -d -l 1 big d; ls d* | sed -n '90p;91p;95p'; }")
    expect(r.out).toBe('d89\nd9000\nd9004\n')
  })
  it('-a fixes the length and stops when the names run out', async () => {
    const r = await run('seq 1 30 > big', '{ split -d -a 1 -l 1 big u; echo rc=$?; ls u* | wc -l; }')
    expect(r.out).toBe('rc=1\n10\n')
    expect(r.err).toBe('split: output file suffixes exhausted\n')
  })
  it('hex suffixes', async () => {
    const r = await run('seq 1 40 > big', "{ split -x -l 2 big x; ls x* | tr '\\n' ' '; }")
    expect(r.out).toBe('x00 x01 x02 x03 x04 x05 x06 x07 x08 x09 x0a x0b x0c x0d x0e x0f x10 x11 x12 x13 ')
  })
})
