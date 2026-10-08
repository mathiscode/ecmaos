import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

describe.skipIf(!supported)('the login prompt on the console (--login)', () => {
  it('asks for a user, refuses a wrong password, logs in, and asks again after exit', async () => {
    const session = new Session(['--ephemeral', '--login'])
    try {
      await session.waitFor('login: ', 0, 30_000)

      session.send('root\r')
      await session.waitFor('assword', 0, 10_000)
      session.send('wrong-password\r')
      await session.waitFor('login: ', session.output.lastIndexOf('assword'), 20_000)
      expect(session.output).not.toContain('root:/root# ')

      const second = session.output.lastIndexOf('login: ')
      session.send('root\r')
      await session.waitFor('assword', second, 10_000)
      session.send('root\r')
      await session.waitFor('root:/root# ', second, 20_000)

      const before = session.output.length
      session.send('id\r')
      await session.waitFor('uid=0', before, 10_000)
      session.send('exit\r')
      await session.waitFor('login: ', before, 20_000)

      // a machine with only a console runs a getty there and nowhere else
      expect(session.output).not.toMatch(/cannot start \/sbin\/getty/)
    } finally {
      await session.stop()
    }
  }, 120_000)
})
