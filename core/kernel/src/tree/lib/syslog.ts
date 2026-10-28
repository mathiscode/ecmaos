/**
 * `/dev/log` and `/dev/kmsg`: where messages from `logger`, and from a script that writes to them, go. On Linux `/dev/log` is
 * the socket syslogd reads; there are no Unix datagram sockets here, so it is a character device instead, and the kernel
 * itself plays syslogd: each write is a syslog message (`<PRI>tag[pid]: text`, the priority optional) and is appended to
 * `/var/log/messages` as `Mon dd hh:mm:ss host tag[pid]: text`. A C program's `syslog()` connects to a socket and so does not
 * reach it. `/dev/kmsg` takes messages for the kernel log (the same file `dmesg` shows); it cannot be read.
 */

import { Class } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'
import type { KernelCharDevice, KernelDevice } from '@ecmaos/types'

/** Where the messages go; the kernel sets it once its log files exist, and until then a write is accepted and dropped */
export interface SyslogSink {
  /** Appends lines to `/var/log/messages` */
  messages(text: string): void
  /** Writes a line to the kernel log at a syslog level (0 to 7) */
  kernel(level: number, text: string): void
  hostname(): string
}

let sink: SyslogSink | undefined
export const setSyslogSink = (next: SyslogSink | undefined): void => { sink = next }

const decoder = new TextDecoder()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `<13>text` is priority 13 (facility 1 user, level 5 notice) and `text`; no prefix is user.notice */
export function parsePriority(line: string): { priority: number, text: string } {
  const match = /^<(\d{1,3})>/.exec(line)
  if (!match) return { priority: 13, text: line }
  return { priority: Math.min(Number(match[1]), 191), text: line.slice(match[0].length) }
}

/** The line in `/var/log/messages` for a message written at `now` */
export function messageLine(text: string, host: string, now: Date): string {
  const day = String(now.getDate()).padStart(2, ' ')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  return `${MONTHS[now.getMonth()]} ${day} ${time} ${host} ${text}\n`
}

/** The lines of a write; each is a message, and an empty one is not */
const linesOf = (buffer: Uint8Array): string[] =>
  decoder.decode(buffer).split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')

const sinkOperations = (deliver: (line: string) => void): FileOperations => ({
  read() { throw withErrno('EINVAL') },
  write(_file, buffer) {
    if (sink) for (const line of linesOf(buffer)) deliver(line)
    return buffer.length
  }
})

export const logOperations: FileOperations = sinkOperations(line => {
  const { text } = parsePriority(line)
  sink!.messages(messageLine(text, sink!.hostname(), new Date()))
})

export const kmsgOperations: FileOperations = sinkOperations(line => {
  const { priority, text } = parsePriority(line)
  sink!.kernel(priority & 7, text)
})

const mem_class = new Class('mem', { dev_node: (device: { name: string }) => ({ name: device.name, mode: device.name === 'log' ? 0o666 : 0o644 }) })

export const SyslogDevice: KernelDevice = {
  pkg: { name: 'syslog', version: '0.1.0', description: 'The system log: /dev/log for messages, /dev/kmsg for the kernel log' },
  async getDrivers(): Promise<KernelCharDevice[]> {
    return [
      // /dev/kmsg is 1:11 on Linux, a major the memory devices hold; /dev/log is a socket there. Both are ecmaOS's own numbers, in misc
      { name: 'kmsg', major: 10, minor: 220, class: mem_class, ops: kmsgOperations },
      { name: 'log', major: 10, minor: 219, class: mem_class, ops: logOperations }
    ]
  }
}
