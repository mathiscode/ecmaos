import { describe, expect, it, vi } from 'vitest'

import { activateTerminalLink, parseKernelExecuteLink, type LinkActivationDeps } from '#terminal.ts'

function deps(confirmAnswer: boolean): LinkActivationDeps & { confirm: ReturnType<typeof vi.fn>, execute: ReturnType<typeof vi.fn>, openUrl: ReturnType<typeof vi.fn> } {
  return {
    confirm: vi.fn(() => confirmAnswer),
    execute: vi.fn(),
    openUrl: vi.fn()
  }
}

describe('parseKernelExecuteLink', () => {
  it('percent-decodes the command and splits args on whitespace', () => {
    expect(parseKernelExecuteLink('ecmaos://kernel.execute?command=echo&args=hello%20big%20world'))
      .toEqual({ command: 'echo', args: ['hello', 'big', 'world'] })
  })

  it('keeps an = inside a value instead of truncating it', () => {
    expect(parseKernelExecuteLink('ecmaos://kernel.execute?command=env&args=A%3D1%20B=2'))
      .toEqual({ command: 'env', args: ['A=1', 'B=2'] })
  })

  it('refuses links that are not kernel.execute, lack a command, or are malformed', () => {
    expect(parseKernelExecuteLink('https://ecmaos.sh')).toBeNull()
    expect(parseKernelExecuteLink('ecmaos://kernel.reboot?command=x')).toBeNull()
    expect(parseKernelExecuteLink('ecmaos://kernel.execute?args=x')).toBeNull()
    expect(parseKernelExecuteLink('ecmaos://kernel.execute?command=%E0%A4%A')).toBeNull()
  })
})

describe('activateTerminalLink', () => {
  const link = 'ecmaos://kernel.execute?command=rm&args=-rf%20%2Fhome'

  it('does not execute anything when the user declines', async () => {
    const d = deps(false)
    expect(await activateTerminalLink(link, d)).toBe(false)
    expect(d.confirm).toHaveBeenCalledOnce()
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('shows the exact decoded command line, and runs it only after a yes', async () => {
    const d = deps(true)
    expect(await activateTerminalLink(link, d)).toBe(true)
    expect(d.confirm.mock.calls[0]![0]).toContain('rm -rf /home')
    expect(d.execute).toHaveBeenCalledWith({ command: 'rm', args: ['-rf', '/home'] })
  })

  it('opens http(s) links without prompting or executing', async () => {
    const d = deps(true)
    await activateTerminalLink('https://ecmaos.sh', d)
    expect(d.openUrl).toHaveBeenCalledWith('https://ecmaos.sh')
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('never prompts for a link it cannot parse', async () => {
    const d = deps(true)
    expect(await activateTerminalLink('ecmaos://kernel.execute?nothing=here', d)).toBe(false)
    expect(d.confirm).not.toHaveBeenCalled()
  })
})
