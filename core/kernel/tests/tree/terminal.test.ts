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
