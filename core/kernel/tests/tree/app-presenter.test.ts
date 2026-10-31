import { describe, expect, it } from 'vitest'

import { appShell } from '#lib/presenters/app.ts'

const credentials = (euid: number) => ({ uid: euid, gid: euid, suid: euid, sgid: euid, euid, egid: euid, groups: [] })
const shell = (euid: number) => ({ credentials: credentials(euid), name: `shell-${euid}` })

/** A kernel that says whether programs run as their user, with the root shell and what `shellAsProcess` makes */
const kernelWith = (programsRunAsUser: boolean) => {
  const made: unknown[] = []
  return { made, kernel: { programsRunAsUser, shell: shell(0), shellAsProcess: (proc: unknown) => { made.push(proc); return shell(1000) } } as never }
}
const processOf = (euid: number) => ({ context: { credentials: credentials(euid), pwd: '/home/tester' }, env: {} }) as never

describe('the shell a DOM app acts through', () => {
  it('is the registered shell when it is the process\'s own user', () => {
    const { kernel, made } = kernelWith(true)
    const own = shell(1000)
    expect(appShell(kernel, processOf(1000), own as never)).toBe(own)
    expect(made).toEqual([])
  })

  it('is a shell for the process\'s user when a `su` started it and no shell is registered', () => {
    const { kernel, made } = kernelWith(true)
    const result = appShell(kernel, processOf(1000)) as unknown as { credentials: { euid: number } }
    expect(result.credentials.euid).toBe(1000)
    expect(made).toHaveLength(1)
  })

  it('is not root\'s shell for a user process that was registered with root\'s', () => {
    const { kernel } = kernelWith(true)
    expect((appShell(kernel, processOf(1000), shell(0) as never) as unknown as { credentials: { euid: number } }).credentials.euid).toBe(1000)
  })

  it('is the kernel\'s shell for a root process, and everywhere programs all run as root', () => {
    const root = kernelWith(true)
    expect(appShell(root.kernel, processOf(0))).toBe((root.kernel as { shell: unknown }).shell)
    const flat = kernelWith(false)
    expect(appShell(flat.kernel, processOf(1000))).toBe((flat.kernel as { shell: unknown }).shell)
    expect(flat.made).toEqual([])
  })
})
