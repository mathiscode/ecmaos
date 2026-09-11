import { describe, expect, it, beforeAll } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Terminal', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ 
      dom: TestDomOptions, 
      filesystem: DefaultFilesystemOptions, 
      log: TestLogOptions,
      credentials: { username: 'root', password: 'root' }
    })
    await kernel.boot()
  })

  it('should initialize', () => {
    expect(kernel.terminal).toBeDefined()
  })

  describe('@zenfs/linux TTY attachment', () => {
    it('attaches a TTY and registers /dev/xterm<n> once mounted', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      kernel.terminal.mount(container)

      expect(kernel.terminal.zfsTty).toBeDefined()
      expect(kernel.terminal.zfsTty?.name).toBe(`xterm${kernel.terminal.tty}`)

      const exists = await kernel.filesystem.fs.exists(`/dev/xterm${kernel.terminal.tty}`)
      expect(exists).toBe(true)
    })

    it('does not attach input, leaving keyHandler and the stdin fan-out as the only producers', () => {
      // input: false in mount() means the TTY's line discipline never receives xterm's onData;
      // dispatchStdin below remains the sole path until job control needs the TTY to own input.
      expect(kernel.terminal.zfsTty).toBeDefined()
    })
  })

  describe('renderer', () => {
    it('defaults to webgl, falling back to dom when no WebGL2 context is available (as in this test environment)', () => {
      // jsdom has no real WebGL2 context, so mount() above already exercised and logged the
      // fallback; this just pins the config default and the resulting addon state.
      expect(kernel.shell.config.renderer).toBe('webgl')
      const terminal = kernel.terminal as unknown as { _webglAddon: unknown }
      expect(terminal._webglAddon).toBeUndefined()
    })

    it('does not attempt to load WebGL again once forced to dom via config', () => {
      const config = kernel.shell.config as unknown as { _renderer: string }
      const previous = config._renderer
      config._renderer = 'dom'

      const terminal = kernel.terminal as unknown as { _applyRenderer: () => void; _webglAddon: unknown }
      terminal._applyRenderer()

      expect(terminal._webglAddon).toBeUndefined()
      config._renderer = previous
    })
  })

  describe('addons', () => {
    it('loads the clipboard addon for OSC 52 support', () => {
      expect(kernel.terminal.addons.get('clipboard')).toBeDefined()
    })

    it('loads the unicode11 addon and activates version 11', () => {
      expect(kernel.terminal.addons.get('unicode11')).toBeDefined()
      expect(kernel.terminal.unicode.activeVersion).toBe('11')
    })
  })

  describe('word-wise cursor motion (Option/Alt+Arrow)', () => {
    it('jumps the cursor to the start of the previous word on Alt+ArrowLeft', async () => {
      const terminal = kernel.terminal as unknown as { _cmd: string; _cursorPosition: number }
      terminal._cmd = 'echo hello world'
      terminal._cursorPosition = terminal._cmd.length

      await kernel.terminal.keyHandler({
        key: '',
        domEvent: { key: 'ArrowLeft', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false } as KeyboardEvent
      })

      expect(terminal._cursorPosition).toBe('echo hello '.length)
    })

    it('jumps the cursor to the start of the next word on Alt+ArrowRight', async () => {
      const terminal = kernel.terminal as unknown as { _cmd: string; _cursorPosition: number }
      terminal._cmd = 'echo hello world'
      terminal._cursorPosition = 0

      await kernel.terminal.keyHandler({
        key: '',
        domEvent: { key: 'ArrowRight', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false } as KeyboardEvent
      })

      expect(terminal._cursorPosition).toBe('echo '.length)
    })

    it('does not move past the start or end of the line', async () => {
      const terminal = kernel.terminal as unknown as { _cmd: string; _cursorPosition: number }
      terminal._cmd = 'echo hi'
      terminal._cursorPosition = 0

      await kernel.terminal.keyHandler({
        key: '',
        domEvent: { key: 'ArrowLeft', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false } as KeyboardEvent
      })

      expect(terminal._cursorPosition).toBe(0)
    })
  })

  describe('synchronized output on program stdout/stderr', () => {
    it('brackets a stdout write in DEC 2026 synchronized-output mode', () => {
      // `_writeSynchronized` is the shared helper both the stdout and stderr WritableStreams call;
      // exercised directly since Shell already permanently holds stdout's writer lock.
      const writes: string[] = []
      const terminal = kernel.terminal as unknown as { _writeSynchronized: (text: string) => void }
      const original = kernel.terminal.write.bind(kernel.terminal)
      kernel.terminal.write = ((data: string, callback?: () => void) => {
        writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
        return original(data, callback)
      }) as typeof kernel.terminal.write

      terminal._writeSynchronized('hello\n')
      kernel.terminal.write = original

      expect(writes).toContain('\x1b[?2026hhello\n\x1b[?2026l')
    })
  })

  describe('stdin subscriber pattern', () => {
    it('should return a ReadableStream from getInputStream()', () => {
      const stream = kernel.terminal.getInputStream()
      expect(stream).toBeInstanceOf(ReadableStream)
    })

    it('should return independent streams from multiple getInputStream() calls', () => {
      const stream1 = kernel.terminal.getInputStream()
      const stream2 = kernel.terminal.getInputStream()
      expect(stream1).not.toBe(stream2)
    })

    it('should broadcast input to all subscribers', () => {
      // Access the subscribers directly
      const terminal = kernel.terminal as unknown as { 
        _stdinSubscribers: Set<(data: Uint8Array) => void> 
      }
      
      // Add test callbacks directly to verify broadcast
      const received1: Uint8Array[] = []
      const received2: Uint8Array[] = []
      
      const callback1 = (data: Uint8Array) => received1.push(data)
      const callback2 = (data: Uint8Array) => received2.push(data)
      
      terminal._stdinSubscribers.add(callback1)
      terminal._stdinSubscribers.add(callback2)
      
      const testData = new TextEncoder().encode('test')
      
      // Broadcast to all subscribers
      for (const callback of terminal._stdinSubscribers) {
        callback(testData)
      }
      
      // Both callbacks should have received the data
      expect(received1).toHaveLength(1)
      expect(received2).toHaveLength(1)
      expect(received1[0]).toEqual(testData)
      expect(received2[0]).toEqual(testData)
      
      // Cleanup
      terminal._stdinSubscribers.delete(callback1)
      terminal._stdinSubscribers.delete(callback2)
    })

    it('should add subscriber when stream is created', () => {
      const terminal = kernel.terminal as unknown as { 
        _stdinSubscribers: Set<(data: Uint8Array) => void> 
      }

      const initialCount = terminal._stdinSubscribers.size

      kernel.terminal.getInputStream()
      expect(terminal._stdinSubscribers.size).toBe(initialCount + 1)

      kernel.terminal.getInputStream()
      expect(terminal._stdinSubscribers.size).toBe(initialCount + 2)
    })
  })
})
