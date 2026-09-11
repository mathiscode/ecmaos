import { afterEach, describe, expect, it } from 'vitest'

import { define_syscall, dispatch } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'

import { installSyscallPolicy, invalidateManifestCache } from '#lib/syscall-policy.ts'

/** A minimal fake of the fs.promises surface installSyscallPolicy actually uses. */
function fakeFs(manifests: Record<string, unknown>) {
  return {
    exists: async (path: string) => path in manifests,
    readFile: async (path: string) => JSON.stringify(manifests[path])
  } as unknown as Parameters<typeof installSyscallPolicy>[0]
}

let uniqueCounter = 0
/** Register a fresh no-op syscall so each test gets its own untouched name in the shared table. */
function registerTestSyscall(): string {
  const name = `__test_syscall_${uniqueCounter++}`
  define_syscall(name as never, () => 42)
  return name
}

function fakeProcess(exe?: string): Process {
  return { exe } as Process
}

describe('installSyscallPolicy', () => {
  it('lets an unrestricted program (no manifest) call any syscall', async () => {
    const name = registerTestSyscall()
    installSyscallPolicy(fakeFs({}))
    const result = await dispatch(fakeProcess('/bin/unmanifested'), name as never, [])
    expect(result).toBe(42)
  })

  it('lets a manifest-declared program call an allowed syscall', async () => {
    const name = registerTestSyscall()
    installSyscallPolicy(fakeFs({ '/bin/allowed.manifest.json': { syscalls: [name] } }))
    const result = await dispatch(fakeProcess('/bin/allowed'), name as never, [])
    expect(result).toBe(42)
  })

  it('refuses a syscall not in the manifest with -EPERM', async () => {
    const name = registerTestSyscall()
    installSyscallPolicy(fakeFs({ '/bin/restricted.manifest.json': { syscalls: ['some_other_call'] } }))
    const result = await dispatch(fakeProcess('/bin/restricted'), name as never, [])
    expect(result).toBe(-1)
  })

  it('treats a malformed manifest as no manifest at all', async () => {
    const name = registerTestSyscall()
    const fs = {
      exists: async () => true,
      readFile: async () => 'not valid json{{'
    } as unknown as Parameters<typeof installSyscallPolicy>[0]

    installSyscallPolicy(fs)
    const result = await dispatch(fakeProcess('/bin/broken'), name as never, [])
    expect(result).toBe(42)
  })

  it('does not restrict a process with no exe path at all', async () => {
    const name = registerTestSyscall()
    installSyscallPolicy(fakeFs({}))
    const result = await dispatch(fakeProcess(undefined), name as never, [])
    expect(result).toBe(42)
  })

  afterEach(() => { invalidateManifestCache() })
})
